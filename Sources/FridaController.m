#import "FridaController.h"
#import "APFPrefs.h"
#import "APFMenu.h"
#import "APFLogManager.h"
#import <frida-core.h>
#import <sys/sysctl.h>
#import <sys/stat.h>
#import <zlib.h>

static const char *kFoodyBundleID = "vn.foody.nowpartner";
// Có thể đổi bằng NSUserDefaults key "frida_server_host" (vd "127.0.0.1:28042")
static NSString *const kDefaultFridaHost  = @"127.0.0.1:28042";
static NSString *const kDefaultJSURL = @"https://phau.io.vn/upload/frida-agent.js";

static __unsafe_unretained FridaController *gController = nil;
static GMainLoop *gFridaMainLoop = NULL;

static void frida_on_script_message(FridaScript *script,
                                    const gchar *message,
                                    GBytes *data,
                                    gpointer user_data) {
    if (!message) return;
    NSString *msg = [NSString stringWithUTF8String:message];
    if (!msg) return;                       // FIX: UTF8 lỗi -> nil -> JSON exception
    FridaController *ctrl = (__bridge FridaController *)user_data;
    if (!ctrl) ctrl = gController;
    if (!ctrl) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        [ctrl handleMessage:msg];
    });
}

static void frida_on_script_destroyed(FridaScript *script, gpointer user_data) {
    NSLog(@"[Frida] ⚠️ SCRIPT DESTROYED");
    FridaController *ctrl = (__bridge FridaController *)user_data;
    if (!ctrl) ctrl = gController;
    if (ctrl) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (ctrl.logHandler) ctrl.logHandler(@[@"⚠️ CẢNH BÁO: Frida Script bị hủy (có thể do file JS lỗi)"]);
        });
    }
}

static void frida_on_session_detached(FridaSession *session,
                                       FridaSessionDetachReason reason,
                                       FridaCrash *crash,
                                       gpointer user_data) {
    FridaController *ctrl = (__bridge FridaController *)user_data;
    if (!ctrl) ctrl = gController;
    if (!ctrl) return;

    NSString *reasonStr = @"Unknown";
    switch (reason) {
        case FRIDA_SESSION_DETACH_REASON_APPLICATION_REQUESTED:
            reasonStr = @"App tự yêu cầu detach"; break;
        case FRIDA_SESSION_DETACH_REASON_PROCESS_REPLACED:
            reasonStr = @"Process bị thay thế"; break;
        case FRIDA_SESSION_DETACH_REASON_PROCESS_TERMINATED:
            reasonStr = @"🛑 Foody đã đóng / bị kill"; break;
        case FRIDA_SESSION_DETACH_REASON_DEVICE_LOST:
            reasonStr = @"⚠️ Device bị mất"; break;
        default:
            reasonStr = [NSString stringWithFormat:@"Lý do khác (%d)", (int)reason];
            break;
    }
    // FIX: chỉ so sánh con trỏ, không deref -> bỏ qua detach của session cũ
    uintptr_t sid = (uintptr_t)session;
    dispatch_async(dispatch_get_main_queue(), ^{
        [ctrl handleDetach:reasonStr sessionId:sid];
    });
}

@interface FridaController ()
@property (nonatomic, assign) FridaDeviceManager *manager;
@property (nonatomic, assign) FridaDevice *device;
@property (nonatomic, assign) FridaSession *session;
@property (nonatomic, assign) FridaScript *script;
@property (nonatomic, assign) guint spawnedPid;
@property (nonatomic, assign) CFAbsoluteTime sessionStartedAt; // used only for lifecycle diagnostics
@property (nonatomic, strong) NSString *jsSource;
@property (nonatomic, strong) NSRecursiveLock *opLock;      // FIX: tuần tự hoá mọi thao tác Frida
@property (nonatomic, assign) BOOL scriptReady;             // FIX: script đã load xong mới coi là attached
@property (nonatomic, assign) BOOL attaching;               // FIX: chặn attach song song
@property (nonatomic, assign) CFAbsoluteTime lastDeviceFail;
@end

@implementation FridaController

+ (instancetype)shared {
    static FridaController *i;
    static dispatch_once_t t;
    dispatch_once(&t, ^{
        i = [FridaController new];
        gController = i;

        frida_init();
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            gFridaMainLoop = g_main_loop_new(NULL, FALSE);
            g_main_loop_run(gFridaMainLoop);
        });

        [[NSNotificationCenter defaultCenter] addObserverForName:@"APFPrefsDidChangeNotification"
                                                          object:nil
                                                           queue:[NSOperationQueue mainQueue]
                                                      usingBlock:^(NSNotification *note) {
            if ([i isAttached]) {
                [i updatePrefs:[[APFPrefs shared] toDictionary]];
            }
        }];

        [APFMenu setReloadJSCallback:^{ [i reloadJSFromRemote]; }];

    });
    return i;
}

- (instancetype)init {
    if (self = [super init]) {
        _opLock = [[NSRecursiveLock alloc] init];
    }
    return self;
}

- (void)dealloc { [self detach]; frida_shutdown(); }

#pragma mark - JS Source management

- (void)setJSRemoteURL:(NSString *)url {
    if (!url) return;
    [[NSUserDefaults standardUserDefaults] setObject:url forKey:@"js_remote_url"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

- (NSString *)jsRemoteURL {
    NSString *url = [[NSUserDefaults standardUserDefaults] stringForKey:@"js_remote_url"];
    if (url.length == 0) url = kDefaultJSURL;
    return url;
}

// FIX: không block main thread (trước đây gọi từ menu -> đơ UI tối đa 8s)
- (void)reloadJSFromRemote {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        @synchronized(self) {
            self->_jsSource = nil;
            [[NSFileManager defaultManager] removeItemAtPath:[self jsCachePath] error:nil];
        }

        NSString *remote = [self fetchRemoteJS];
        @synchronized(self) {
            if (remote) {
                self->_jsSource = [self sanitizeJS:remote];
                [self->_jsSource writeToFile:[self jsCachePath] atomically:YES encoding:NSUTF8StringEncoding error:nil];
                if (self.logHandler) self.logHandler(@[@"✅ Đã tải JS mới từ Server thành công"]);
            } else {
                if (self.logHandler) self.logHandler(@[@"⚠️ Không tải được từ Server — dùng bản Bundle trong máy"]);
            }
        }
    });
}

- (NSString *)jsCachePath {
    NSArray *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    return [docs[0] stringByAppendingPathComponent:@"frida-agent-cache.js"];
}

- (NSString *)sanitizeJS:(NSString *)raw {
    if (!raw || raw.length == 0) return nil;
    NSString *clean = [raw stringByReplacingOccurrencesOfString:@"\uFEFF" withString:@""];
    clean = [clean stringByReplacingOccurrencesOfString:@"\u200B" withString:@""];
    clean = [clean stringByReplacingOccurrencesOfString:@"\u200C" withString:@""];
    clean = [clean stringByReplacingOccurrencesOfString:@"\u200D" withString:@""];
    clean = [clean stringByReplacingOccurrencesOfString:@"\u00A0" withString:@" "];
    clean = [clean stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\n"];
    clean = [clean stringByReplacingOccurrencesOfString:@"\r" withString:@"\n"];
    return [clean stringByAppendingString:@"\n"];
}

- (NSString *)fetchRemoteJS {
    NSString *urlStr = [self jsRemoteURL];
    NSURL *url = [NSURL URLWithString:urlStr];
    if (!url) return nil;

    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.timeoutInterval = 8.0;
    req.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    [req setValue:@"no-cache" forHTTPHeaderField:@"Cache-Control"];

    NSURLResponse *resp = nil;
    NSError *err = nil;
    NSData *data = [NSURLConnection sendSynchronousRequest:req returningResponse:&resp error:&err];
    if (!data || err) return nil;

    if ([resp isKindOfClass:[NSHTTPURLResponse class]]) {
        if ([(NSHTTPURLResponse *)resp statusCode] != 200) return nil;
    }

    NSString *js = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!js || js.length < 100) return nil;
    if ([js hasPrefix:@"<!DOCTYPE"] || [js hasPrefix:@"<html"]) return nil;
    return [self sanitizeJS:js];
}

- (NSString *)bundledJSSource {
    NSString *p = [[NSBundle mainBundle] pathForResource:@"frida-agent-bundle" ofType:@"js"];
    if (p) {
        NSData *rawData = [NSData dataWithContentsOfFile:p];
        if (rawData && rawData.length > 100) {
            NSString *bundled = [[NSString alloc] initWithData:rawData encoding:NSUTF8StringEncoding];
            if (bundled && bundled.length > 100) {
                return [self sanitizeJS:bundled];
            }
        }
    }
    return nil;
}

- (NSString *)jsSource {
    @synchronized(self) {
        if (_jsSource && _jsSource.length > 100) return _jsSource;
    }

    // The bundled agent belongs to this IPA version and is the default source.
    // Do not let a stale cached or remote JS silently override fixes in a newly installed build.
    NSString *bundled = [self bundledJSSource];
    if (bundled && bundled.length > 100) {
        @synchronized(self) { _jsSource = bundled; }
        return bundled;
    }

    // Cache/remote are fallback only for older builds that lack the bundled resource.
    @synchronized(self) {
        NSString *cachePath = [self jsCachePath];
        if ([[NSFileManager defaultManager] fileExistsAtPath:cachePath]) {
            NSString *cached = [NSString stringWithContentsOfFile:cachePath encoding:NSUTF8StringEncoding error:nil];
            if (cached && cached.length > 100 && ![cached hasPrefix:@"<"]) {
                _jsSource = [self sanitizeJS:cached];
                return _jsSource;
            }
        }
    }
    NSString *remote = [self fetchRemoteJS];
    if (remote && remote.length > 100) {
        NSString *sanitized = [self sanitizeJS:remote];
        @synchronized(self) { _jsSource = sanitized; }
        [sanitized writeToFile:[self jsCachePath] atomically:YES encoding:NSUTF8StringEncoding error:nil];
        return sanitized;
    }
    return nil;
}

#pragma mark - Device / Session lifetime

- (NSArray<NSString *> *)candidateHosts {
    NSString *custom = [[NSUserDefaults standardUserDefaults] stringForKey:@"frida_server_host"];
    NSMutableArray *a = [NSMutableArray array];
    if (custom.length) [a addObject:custom];
    if (![a containsObject:kDefaultFridaHost])  [a addObject:kDefaultFridaHost];
    return a;
}

// Giải phóng session/script. Gọi khi đã giữ @synchronized(self).
- (void)releaseSessionLockedGraceful:(BOOL)graceful {
    FridaScript *sc = self.script;
    FridaSession *se = self.session;
    self.script = NULL;
    self.session = NULL;
    self.scriptReady = NO;
    self.spawnedPid = 0;
    self.sessionStartedAt = 0;

    // FIX: ngắt signal trước khi unref để callback cũ không chạm vào state mới
    if (sc) g_signal_handlers_disconnect_by_data(sc, (__bridge gpointer)self);
    if (se) g_signal_handlers_disconnect_by_data(se, (__bridge gpointer)self);

    if (graceful) {                       // chỉ dùng được ở background thread
        if (sc) { GError *e = NULL; frida_script_unload_sync(sc, NULL, &e); if (e) g_error_free(e); }
        if (se) { GError *e = NULL; frida_session_detach_sync(se, NULL, &e); if (e) g_error_free(e); }
    }
    if (sc) g_object_unref(sc);
    if (se) g_object_unref(se);
}

// Giữ opLock. Đóng device + manager để lần sau tạo mới sạch sẽ.
- (void)resetDeviceLockedGraceful:(BOOL)graceful {
    FridaDevice *d = NULL; FridaDeviceManager *m = NULL;
    @synchronized(self) { d = self.device; m = self.manager; self.device = NULL; self.manager = NULL; }
    if (d) g_object_unref(d);
    if (m) {
        if (graceful) { GError *e = NULL; frida_device_manager_close_sync(m, NULL, &e); if (e) g_error_free(e); }
        g_object_unref(m);
    }
}

#pragma mark - Acquire device & Process

// LUÔN trả về +1 ref — người gọi PHẢI g_object_unref().  (FIX use-after-free)
- (FridaDevice *)acquireDeviceLocked:(NSError **)err {
    @synchronized(self) {
        if (self.device) return g_object_ref(self.device);
    }
    if (!self.manager) self.manager = frida_device_manager_new();

    NSString *lastMsg = nil;
    for (NSString *host in [self candidateHosts]) {
        GError *ge = NULL;
        FridaDevice *rd = frida_device_manager_add_remote_device_sync(
            self.manager, host.UTF8String, NULL, NULL, &ge);
        if (!rd) {
            if (ge) { lastMsg = [NSString stringWithUTF8String:ge->message]; g_error_free(ge); }
            continue;
        }
        FridaProcessList *pl = frida_device_enumerate_processes_sync(rd, NULL, NULL, &ge);
        if (pl) {
            g_object_unref(pl);
            @synchronized(self) { self.device = rd; }   // self.device giữ 1 ref
            return g_object_ref(rd);                    // người gọi giữ 1 ref riêng
        }
        if (ge) { lastMsg = [NSString stringWithUTF8String:ge->message]; g_error_free(ge); ge = NULL; }
        g_object_unref(rd);
        GError *re = NULL;
        frida_device_manager_remove_remote_device_sync(self.manager, host.UTF8String, NULL, &re);
        if (re) g_error_free(re);
    }

    // Fallback: local device
    GError *ge = NULL;
    FridaDeviceList *devs = frida_device_manager_enumerate_devices_sync(self.manager, NULL, &ge);
    if (!devs) {
        if (ge) g_error_free(ge);
        self.lastDeviceFail = CFAbsoluteTimeGetCurrent();
        if (err) *err = [NSError errorWithDomain:@"Frida" code:2 userInfo:@{NSLocalizedDescriptionKey:
            [NSString stringWithFormat:@"Không kết nối được frida-server (%@). Kiểm tra: ps aux | grep frida%@",
             [[self candidateHosts] componentsJoinedByString:@", "],
             lastMsg ? [@" — " stringByAppendingString:lastMsg] : @""]}];
        return NULL;
    }

    FridaDevice *localDev = NULL;
    gint n = frida_device_list_size(devs);
    for (gint i = 0; i < n; i++) {
        FridaDevice *d = frida_device_list_get(devs, i);     // +1 ref cho tôi
        if (!localDev && frida_device_get_dtype(d) == FRIDA_DEVICE_TYPE_LOCAL) localDev = d;
        else g_object_unref(d);
    }
    g_object_unref(devs);

    if (!localDev) {
        self.lastDeviceFail = CFAbsoluteTimeGetCurrent();
        if (err) *err = [NSError errorWithDomain:@"Frida" code:3
            userInfo:@{NSLocalizedDescriptionKey:@"Không có frida-server / local device"}];
        return NULL;
    }
    @synchronized(self) { self.device = localDev; }
    return g_object_ref(localDev);
}

- (FridaDevice *)acquireDevice:(NSError **)err {
    [self.opLock lock];
    @try { return [self acquireDeviceLocked:err]; }
    @finally { [self.opLock unlock]; }
}

- (guint)findRunningFoodyPidForce:(BOOL)force {
    // Throttle: tránh spam kết nối mỗi giây khi frida-server chưa chạy
    if (!force && !self.device &&
        CFAbsoluteTimeGetCurrent() - self.lastDeviceFail < 5.0) return 0;

    NSError *e = nil;
    FridaDevice *dev = [self acquireDeviceLocked:&e];
    if (!dev) return 0;

    GError *ge = NULL;
    FridaProcessList *procs = frida_device_enumerate_processes_sync(dev, NULL, NULL, &ge);
    guint foundPid = 0;

    if (procs) {
        gint n = frida_process_list_size(procs);
        for (gint i = 0; i < n; i++) {
            FridaProcess *p = frida_process_list_get(procs, i);   // +1 ref
            const gchar *name = frida_process_get_name(p);
            if (name) {
                NSString *nm = [NSString stringWithUTF8String:name];
                if (nm && ([nm containsString:@"Foody"] || [nm containsString:@"FoodDriver"]
                           || [nm containsString:@"nowpartner"])) {
                    foundPid = frida_process_get_pid(p);
                }
            }
            g_object_unref(p);                                    // FIX: leak
            if (foundPid) break;
        }
        g_object_unref(procs);
    } else {
        // frida-server chết/restart -> bỏ device cũ để lần sau kết nối lại
        [self resetDeviceLockedGraceful:NO];
        self.lastDeviceFail = CFAbsoluteTimeGetCurrent();
    }
    if (ge) g_error_free(ge);
    g_object_unref(dev);
    return foundPid;
}

- (BOOL)isFoodyRunning {
    // FIX: đang attach thì không chen vào (tránh race với timer 1s của UI)
    if (![self.opLock tryLock]) return [self isAttached];
    @try { return [self findRunningFoodyPidForce:NO] > 0; }
    @finally { [self.opLock unlock]; }
}

- (void)handleDetach:(NSString *)reason {
    [self handleDetach:reason sessionId:0];
}

- (void)handleDetach:(NSString *)reason sessionId:(uintptr_t)sid {
    guint endedPID = 0;
    CFAbsoluteTime startedAt = 0;
    @synchronized(self) {
        // A callback from an older Frida session must never affect a newer session.
        if (sid != 0 && (uintptr_t)self.session != sid) return;
        endedPID = self.spawnedPid;
        startedAt = self.sessionStartedAt;
        [self releaseSessionLockedGraceful:NO];
    }

    NSTimeInterval lifetime = (startedAt > 0)
        ? MAX(0.0, CFAbsoluteTimeGetCurrent() - startedAt) : 0.0;
    NSString *detail = [NSString stringWithFormat:
        @"🔌 Session kết thúc: %@ · PID %u · thời gian attach %.1f giây",
        reason ?: @"Unknown", endedPID, lifetime];
    if (self.logHandler) {
        NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithObject:detail];
        if ([(reason ?: @"") containsString:@"Foody đã đóng"] ||
            [(reason ?: @"") containsString:@"PROCESS_TERMINATED"]) {
            [lines addObject:@"ℹ️ Tiến trình đích đã kết thúc hoặc bị hệ thống dừng. Log này không tự xác định được nguyên nhân; kiểm tra crash report của iOS và log của ứng dụng đích trước khi thay đổi cấu hình mạng."];
            if (lifetime >= 240.0 && lifetime <= 360.0) {
                [lines addObject:@"🧭 Tiến trình kết thúc gần mốc 5 phút. Không có bộ hẹn giờ 5 phút chủ động đóng tiến trình trong controller này; cần đối chiếu crash report / server response để phân biệt lỗi ứng dụng với chính sách phía ứng dụng đích."];
            }
        }
        self.logHandler(lines);
    }
    if (self.detachHandler) self.detachHandler(detail);
}

#pragma mark - SPAWN OR ATTACH

- (BOOL)spawnAndAttach:(NSError **)err {
    [[APFLogManager sharedManager] logInfo:@"LIFECYCLE.SPAWN_ATTACH.START" message:@"Bắt đầu quy trình Spawn/Attach Foody" source:@"FRIDA_NATIVE" context:nil];
    @synchronized(self) {
        if (self.attaching) {
            [[APFLogManager sharedManager] logWarning:@"FRIDA.SPAWN_ATTACH.BUSY" message:@"Bỏ qua yêu cầu kết nối trùng khi attach đang chạy" source:@"FRIDA_NATIVE" context:nil];
            if (err) *err = [NSError errorWithDomain:@"Frida" code:1
                userInfo:@{NSLocalizedDescriptionKey:@"Đang attach, vui lòng đợi..."}];
            return NO;
        }
        self.attaching = YES;
    }
    BOOL ok = NO;
    [self.opLock lock];
    @try {
        ok = [self spawnAndAttachLocked:err];
    } @catch (NSException *ex) {          // FIX: không để exception làm văng app
        [[APFLogManager sharedManager] logError:@"FRIDA.SPAWN_ATTACH.EXCEPTION" message:(ex.reason ?: @"Unknown Objective-C exception") source:@"FRIDA_NATIVE" context:nil];
        ok = NO;
        @synchronized(self) { [self releaseSessionLockedGraceful:NO]; }
        if (err) *err = [NSError errorWithDomain:@"Frida" code:99
            userInfo:@{NSLocalizedDescriptionKey:[NSString stringWithFormat:@"Exception: %@", ex.reason]}];
    } @finally {
        [self.opLock unlock];
        @synchronized(self) { self.attaching = NO; }
    }
    return ok;
}

- (BOOL)spawnAndAttachLocked:(NSError **)err {
    // Dọn session cũ (an toàn vì đang ở background thread)
    @synchronized(self) { [self releaseSessionLockedGraceful:YES]; }

    NSError *devErr = nil;
    FridaDevice *dev = [self acquireDeviceLocked:&devErr];
    if (!dev) {
        [[APFLogManager sharedManager] logError:@"FRIDA.DEVICE.ACQUIRE_FAILED" message:(devErr.localizedDescription ?: @"Không lấy được Frida device") source:@"FRIDA_NATIVE" context:nil];
        if (err) *err = devErr; return NO;
    }
    [[APFLogManager sharedManager] logSuccess:@"FRIDA.DEVICE.ACQUIRED" message:@"Đã lấy được Frida device" source:@"FRIDA_NATIVE" context:nil];

    GError *ge = NULL;
    BOOL didSpawn = NO;
    guint pid = [self findRunningFoodyPidForce:YES];

    if (pid > 0) {
        [[APFLogManager sharedManager] logInfo:@"FRIDA.ATTACH.EXISTING_PROCESS" message:@"Foody đã chạy; chọn Attach trực tiếp" source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
        if (self.logHandler)
            self.logHandler(@[[NSString stringWithFormat:@"📎 Foody đang chạy (PID %u) — Attach trực tiếp...", pid]]);
    } else {
        pid = frida_device_spawn_sync(dev, kFoodyBundleID, NULL, NULL, &ge);
        if (pid == 0) {
            NSString *msg = ge ? [NSString stringWithUTF8String:ge->message] : @"unknown";
            if (ge) g_error_free(ge);
            [[APFLogManager sharedManager] logError:@"FRIDA.SPAWN.FAILED" message:[NSString stringWithFormat:@"Spawn fail: %@", msg] source:@"FRIDA_NATIVE" context:nil];
            g_object_unref(dev);
            if (err) *err = [NSError errorWithDomain:@"Frida" code:10
                userInfo:@{NSLocalizedDescriptionKey:[NSString stringWithFormat:@"Spawn fail: %@", msg]}];
            return NO;
        }
        didSpawn = YES;
        [[APFLogManager sharedManager] logSuccess:@"FRIDA.SPAWN.SUCCESS" message:@"Spawn Foody thành công" source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
    }
    self.spawnedPid = pid;

    // Dọn dẹp chung cho mọi nhánh lỗi
    BOOL (^fail)(NSInteger, NSString *) = ^BOOL(NSInteger code, NSString *msg) {
        if (didSpawn) {
            GError *rErr = NULL;
            frida_device_resume_sync(dev, pid, NULL, &rErr);   // không để Foody bị treo ở trạng thái suspended
            if (rErr) g_error_free(rErr);
        }
        @synchronized(self) { [self releaseSessionLockedGraceful:YES]; }
        g_object_unref(dev);
        [[APFLogManager sharedManager] logError:@"FRIDA.LIFECYCLE.STEP_FAILED" message:msg source:@"FRIDA_NATIVE" context:@{@"code":@(code), @"pid":@(pid)}];
        if (err) *err = [NSError errorWithDomain:@"Frida" code:code
            userInfo:@{NSLocalizedDescriptionKey: msg}];
        return NO;
    };

    FridaSession *newSession = frida_device_attach_sync(dev, pid, NULL, NULL, &ge);
    if (!newSession) {
        NSString *msg = ge ? [NSString stringWithUTF8String:ge->message] : @"unknown";
        if (ge) g_error_free(ge);
        [[APFLogManager sharedManager] logError:@"FRIDA.ATTACH.FAILED" message:[NSString stringWithFormat:@"Attach fail: %@", msg] source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
        // frida-server có thể đã chết -> reset để lần sau kết nối lại
        [self resetDeviceLockedGraceful:NO];
        return fail(11, [NSString stringWithFormat:@"Attach fail: %@", msg]);
    }
    @synchronized(self) { self.session = newSession; }
    [[APFLogManager sharedManager] logSuccess:@"FRIDA.ATTACH.SUCCESS" message:@"Attach session thành công" source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
    g_signal_connect(newSession, "detached", G_CALLBACK(frida_on_session_detached), (__bridge gpointer)self);

    NSString *js = [self jsSource];
    if (!js || js.length < 50) return fail(12, @"Không tìm thấy nội dung JS");

    FridaScript *newScript = NULL;
    NSString *firstErr = nil;
    {
        const char *c = js.UTF8String;
        if (c) newScript = frida_session_create_script_sync(newSession, c, NULL, NULL, &ge);
        if (!newScript) {
            firstErr = ge ? [NSString stringWithUTF8String:ge->message] : @"unknown";
            if (ge) { g_error_free(ge); ge = NULL; }
        }
    }
    if (!newScript) {
        // Cache/remote JS lỗi -> xoá cache, thử bản bundle
        [[NSFileManager defaultManager] removeItemAtPath:[self jsCachePath] error:nil];
        @synchronized(self) { _jsSource = nil; }
        NSString *fb = [self bundledJSSource];
        if (fb && ![fb isEqualToString:js]) {
            const char *c = fb.UTF8String;
            if (c) newScript = frida_session_create_script_sync(newSession, c, NULL, NULL, &ge);
        }
        if (!newScript) {
            NSString *msg = ge ? [NSString stringWithUTF8String:ge->message] : firstErr;
            if (ge) g_error_free(ge);
            [[APFLogManager sharedManager] logError:@"FRIDA.HOOK.SCRIPT_CREATE_FAILED" message:[NSString stringWithFormat:@"Create script fail: %@", msg] source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
            return fail(13, [NSString stringWithFormat:@"Create script fail: %@", msg]);
        }
    }

    @synchronized(self) { self.script = newScript; }
    g_signal_connect(newScript, "message",   G_CALLBACK(frida_on_script_message),   (__bridge gpointer)self);
    g_signal_connect(newScript, "destroyed", G_CALLBACK(frida_on_script_destroyed), (__bridge gpointer)self);

    frida_script_load_sync(newScript, NULL, &ge);
    if (ge) {
        NSString *msg = [NSString stringWithUTF8String:ge->message];
        g_error_free(ge);
        [[APFLogManager sharedManager] logError:@"FRIDA.HOOK.LOAD_FAILED" message:[NSString stringWithFormat:@"Load fail: %@", msg] source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
        return fail(14, [NSString stringWithFormat:@"Load fail: %@", msg]);
    }

    @synchronized(self) {
        self.scriptReady = YES;
        self.sessionStartedAt = CFAbsoluteTimeGetCurrent();
    }
    [[APFLogManager sharedManager] logSuccess:@"FRIDA.HOOK.SCRIPT_READY" message:@"Frida script đã load và sẵn sàng" source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
    if (self.logHandler) {
        self.logHandler(@[[NSString stringWithFormat:@"🧭 [LIFECYCLE] Đã attach PID %u · đang theo dõi vòng đời tiến trình.", pid]]);
    }

    if (didSpawn) {
        frida_device_resume_sync(dev, pid, NULL, &ge);
        if (ge) {
            NSString *resumeMessage = [NSString stringWithUTF8String:ge->message] ?: @"Resume failed";
            [[APFLogManager sharedManager] logWarning:@"FRIDA.SPAWN.RESUME_FAILED" message:resumeMessage source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
            g_error_free(ge); ge = NULL;
        } else {
            [[APFLogManager sharedManager] logSuccess:@"FRIDA.SPAWN.RESUMED" message:@"Spawned Foody process resumed" source:@"FRIDA_NATIVE" context:@{@"pid":@(pid)}];
        }
    }
    g_object_unref(dev);

    [[APFPrefs shared] load];
    [self updatePrefs:[[APFPrefs shared] toDictionary]];
    return YES;
}

#pragma mark - Gunzip

// Giới hạn dung lượng sau giải nén (điều chỉnh được). Response order-list thực tế <= 1 MB.
static const NSUInteger kGunzipMaxOutputBytes = 4u * 1024u * 1024u;
static const NSUInteger kGunzipMaxInputBytes  = 1u * 1024u * 1024u;

typedef NS_ENUM(NSInteger, APFGunzipStatus) {
    APFGunzipOK = 0, APFGunzipCorrupt = 1, APFGunzipTooLarge = 2
};

// Trả về dữ liệu đã giải nén; nếu lỗi trả nil và ghi rõ loại lỗi vào *status.
// Dữ liệu không phải GZIP (không có magic 1f 8b) được trả nguyên bản như trước.
- (NSData *)gunzipData:(NSData *)data status:(APFGunzipStatus *)status {
    if (status) *status = APFGunzipOK;
    if (!data || data.length < 2) { if (status) *status = APFGunzipCorrupt; return nil; }
    const uint8_t *bytes = data.bytes;
    if (bytes[0] != 0x1f || bytes[1] != 0x8b) return data;
    if (data.length > kGunzipMaxInputBytes) { if (status) *status = APFGunzipTooLarge; return nil; }

    z_stream strm;
    memset(&strm, 0, sizeof(strm));
    strm.next_in = (Bytef *)bytes;
    strm.avail_in = (uInt)data.length;
    if (inflateInit2(&strm, 16 + MAX_WBITS) != Z_OK) { if (status) *status = APFGunzipCorrupt; return nil; }

    NSMutableData *out = [NSMutableData dataWithCapacity:MIN(data.length * 4, kGunzipMaxOutputBytes)];
    uint8_t buf[32768];
    int ret = Z_OK;
    APFGunzipStatus result = APFGunzipOK;
    do {
        strm.next_out = buf;
        strm.avail_out = sizeof(buf);
        ret = inflate(&strm, Z_NO_FLUSH);
        if (ret == Z_NEED_DICT || ret == Z_STREAM_ERROR || ret == Z_DATA_ERROR ||
            ret == Z_MEM_ERROR || ret == Z_BUF_ERROR) {
            // Z_BUF_ERROR khi không còn input mà chưa tới Z_STREAM_END = dữ liệu bị cắt cụt.
            result = APFGunzipCorrupt;
            break;
        }
        NSUInteger have = sizeof(buf) - strm.avail_out;
        if (have > 0) {
            // Kiểm tra dung lượng TRƯỚC khi append.
            if (out.length + have > kGunzipMaxOutputBytes) { result = APFGunzipTooLarge; break; }
            [out appendBytes:buf length:have];
        }
    } while (ret != Z_STREAM_END && strm.avail_in > 0);

    inflateEnd(&strm);                                    // luôn giải phóng zlib trên mọi nhánh
    if (result == APFGunzipOK && ret != Z_STREAM_END) result = APFGunzipCorrupt;
    if (status) *status = result;
    return result == APFGunzipOK ? out : nil;
}

- (NSData *)gunzipData:(NSData *)data {
    return [self gunzipData:data status:NULL];
}

#pragma mark - Message

- (void)handleMessage:(NSString *)json {
    if (![json isKindOfClass:[NSString class]]) return;
    NSData *d = [json dataUsingEncoding:NSUTF8StringEncoding];
    if (!d) return;                                  // FIX: JSONObjectWithData:nil -> exception
    NSDictionary *m = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
    if (![m isKindOfClass:[NSDictionary class]]) return;

    NSString *type = m[@"type"];
    if (![type isKindOfClass:[NSString class]]) return;

    if ([type isEqualToString:@"error"]) {
        NSString *desc = m[@"description"] ?: @"Unknown error";
        if (self.logHandler) self.logHandler(@[[NSString stringWithFormat:@"🚨 [JS ERROR] %@", desc]]);
        return;
    }

    if ([type isEqualToString:@"send"]) {
        NSDictionary *payload = m[@"payload"];
        if (![payload isKindOfClass:[NSDictionary class]]) return;

        NSString *innerType = payload[@"type"];
        if (![innerType isKindOfClass:[NSString class]]) return;

        if ([innerType isEqualToString:@"logs"]) {
            NSArray *lines = payload[@"logs"] ?: payload[@"lines"];
            if (![lines isKindOfClass:[NSArray class]]) lines = @[];   // FIX: for-in trên non-array
            if (self.logHandler) self.logHandler(lines);
            return;
        }

        if ([innerType isEqualToString:@"gunzip"]) {
            NSString *b64 = payload[@"data"];
            NSNumber *reqId = payload[@"id"];
            if (![b64 isKindOfClass:[NSString class]] || ![reqId isKindOfClass:[NSNumber class]]) return;
            @autoreleasepool {                         // giải phóng NSData/Base64 lớn ngay sau khi gửi xong
                NSData *gz = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
                APFGunzipStatus gst = APFGunzipOK;
                NSData *raw = gz ? [self gunzipData:gz status:&gst] : nil;
                if (!gz) gst = APFGunzipCorrupt;
                NSString *reply;
                if (raw) {
                    reply = [NSString stringWithFormat:
                        @"{\"type\":\"gunzip_reply\",\"id\":%@,\"data\":\"%@\"}",
                        reqId, [raw base64EncodedStringWithOptions:0]];
                } else {
                    reply = [NSString stringWithFormat:
                        @"{\"type\":\"gunzip_reply\",\"id\":%@,\"data\":\"\",\"error\":\"%@\"}",
                        reqId, gst == APFGunzipTooLarge ? @"too_large" : @"corrupt"];
                }
                [self postToScript:reply];
            }
            return;
        }

        if ([innerType isEqualToString:@"match"]) {
            NSDictionary *order = payload[@"order"] ?: payload[@"data"];
            if ([order isKindOfClass:[NSDictionary class]]) {
                [APFMenu notifyMatchDetail:order];
            }
        } else if ([innerType isEqualToString:@"pick_success"]) {
            NSString *info = payload[@"info"];
            if (![info isKindOfClass:[NSString class]]) info = @"Đơn đã pick";
            NSInteger price = [payload[@"price"] integerValue];
            if ([payload[@"forceNotify"] boolValue]) {
                NSMutableDictionary *result = [payload mutableCopy];
                result[@"info"] = info;
                result[@"price"] = @(price);
                [APFMenu showPickResult:result success:YES];
            } else {
                [APFMenu notifySuccessDetail:info price:price];
            }
        } else if ([innerType isEqualToString:@"pick_failed"]) {
            NSString *reason = payload[@"reason"];
            if (![reason isKindOfClass:[NSString class]]) reason = @"Không rõ lý do";
            if ([payload[@"forceNotify"] boolValue]) {
                NSMutableDictionary *result = [payload mutableCopy];
                result[@"responseMessage"] = reason;
                [APFMenu showPickResult:result success:NO];
            } else {
                [APFMenu notifyPickFailed:reason];
            }
        } else if ([innerType isEqualToString:@"assignment_repick_started"]) {
            [APFMenu updateAssignmentHistory:[payload[@"assignmentId"] description] status:@"PICKING" detail:@"Đã gửi request Pick lại; đang chờ response server."];
        } else if ([innerType isEqualToString:@"assignment_repick_failed"]) {
            NSString *reason = [payload[@"reason"] isKindOfClass:[NSString class]] ? payload[@"reason"] : @"Không thể Pick lại Assignment.";
            [APFMenu updateAssignmentHistory:[payload[@"assignmentId"] description] status:@"SKIPPED" detail:reason];
        } else if ([innerType isEqualToString:@"auto_stopped"]) {
            APFPrefs *p = [APFPrefs shared];
            p.enabled = NO;
            [p save];
            if (self.logHandler) self.logHandler(@[@"⏹ [AUTO STOP] Đã tự động tắt Auto Pick"]);
        } else if ([innerType isEqualToString:@"assignment_detected"]) {
            if (self.logHandler) self.logHandler(@[[NSString stringWithFormat:@"🔔 [ASSIGNMENT] Popup event nhận được · %@ · %@ đơn", payload[@"assignmentId"] ?: @"?", payload[@"orderIds"] ?: @[]]]);
            [APFMenu showAssignmentPrompt:payload decisionHandler:^(NSString *action, NSString *assignmentId) {
                if ([action isEqualToString:@"skip"]) [APFMenu saveSkippedAssignment:payload];
                [self resolveAssignment:assignmentId action:action];
            }];
        } else if ([innerType isEqualToString:@"test_result"]) {
            [APFMenu showTestResult:payload];
        } else if ([innerType isEqualToString:@"live_test_preview"]) {
            [APFMenu showLiveApiTestConfirmation:payload decisionHandler:^(BOOL confirmed, NSString *kind, NSString *token) {
                if (confirmed) [self confirmLiveApiTest:kind token:token];
            }];
        }

        if (self.notifyHandler) self.notifyHandler(innerType, payload);
        return;
    }

    if ([type isEqualToString:@"logs"]) {
        NSArray *lines = m[@"logs"] ?: m[@"lines"];
        if (![lines isKindOfClass:[NSArray class]]) lines = @[];
        if (self.logHandler) self.logHandler(lines);
        return;
    }
}

- (void)postToScript:(NSString *)json {
    @synchronized(self) {
        if (!self.script) return;
        frida_script_post(self.script, json.UTF8String, NULL);
    }
}

- (void)updatePrefs:(NSDictionary *)prefs {
    if (!prefs) return;
    NSError *e = nil;
    NSData *d = [NSJSONSerialization dataWithJSONObject:prefs options:0 error:&e];
    if (e || !d) return;
    NSString *js = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    [self postToScript:[NSString stringWithFormat:@"{\"type\":\"prefs\",\"data\":%@}", js]];
}

- (void)start {
    [self updatePrefs:[[APFPrefs shared] toDictionary]];
    [self postToScript:@"{\"type\":\"start\"}"];
}

- (void)stop {
    [self postToScript:@"{\"type\":\"stop\"}"];
}

- (BOOL)isAttached { 
    @synchronized(self) {
        return self.script != NULL && self.scriptReady;
    }
}

- (void)resolveAssignment:(NSString *)assignmentId action:(NSString *)action {
    if (assignmentId.length == 0 || action.length == 0) return;
    NSDictionary *msg = @{@"type": @"assignment_action", @"assignmentId": assignmentId, @"action": action};
    NSData *d = [NSJSONSerialization dataWithJSONObject:msg options:0 error:nil];
    if (!d) return;
    NSString *json = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    [self postToScript:json];
}

- (void)repickAssignment:(NSDictionary *)assignment {
    if (![assignment isKindOfClass:[NSDictionary class]]) return;
    if (![self isAttached]) {
        [APFMenu showPickResult:@{@"info": @"Assignment đã lưu", @"reason": @"Chưa Attach/Spawn ứng dụng tài xế; chưa gửi request.",
            @"responseMessage": @"Chưa Attach/Spawn ứng dụng tài xế; chưa gửi request.", @"forceNotify": @YES} success:NO];
        return;
    }
    NSDictionary *message = @{@"type": @"assignment_repick", @"assignment": assignment};
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    if (!data) {
        [APFMenu showPickResult:@{@"info": @"Assignment đã lưu", @"reason": @"Không thể đóng gói dữ liệu Assignment để gửi sang agent.",
            @"responseMessage": @"Không thể đóng gói dữ liệu Assignment để gửi sang agent.", @"forceNotify": @YES} success:NO];
        return;
    }
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    [self postToScript:json];
}

- (void)previewLiveApiTest:(NSString *)kind {
    NSString *normalized = [kind.lowercaseString isEqualToString:@"mpick"] ? @"mpick" : @"free_pick";
    if (![self isAttached]) {
        [APFMenu showTestResult:@{@"title": @"⚠️ Chưa attach", @"message": @"Chưa kết nối với app tài xế. Không gửi request.", @"liveTest": @YES, @"networkSent": @NO}];
        return;
    }
    NSDictionary *msg = @{@"type": @"test_live_preview", @"kind": normalized};
    NSData *d = [NSJSONSerialization dataWithJSONObject:msg options:0 error:nil];
    if (d) [self postToScript:[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding]];
}

- (void)confirmLiveApiTest:(NSString *)kind token:(NSString *)token {
    if (kind.length == 0 || token.length == 0) return;
    NSDictionary *msg = @{@"type": @"test_live_confirm", @"kind": kind, @"token": token};
    NSData *d = [NSJSONSerialization dataWithJSONObject:msg options:0 error:nil];
    if (d) [self postToScript:[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding]];
}

- (void)detach {
    [self.opLock lock];
    @try {
        // Trên background thread: unload script (chạy dispose() trong agent) rồi mới detach session.
        // Trên main thread không được block, nên giữ đường giải phóng không chờ như trước.
        BOOL graceful = ![NSThread isMainThread];
        @synchronized(self) { [self releaseSessionLockedGraceful:graceful]; }
        [self resetDeviceLockedGraceful:NO];
    } @finally {
        [self.opLock unlock];                         // luôn unlock kể cả khi có exception
    }
}

@end
