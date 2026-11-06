#import "APFMenu.h"
#import "APFLogManager.h"
#import "APFPrefs.h"
#import "FridaController.h"
#import <AudioToolbox/AudioToolbox.h>
#import <UserNotifications/UserNotifications.h>

@interface APFMenu ()
+ (void)showSkippedAssignmentHistoryFromOffset:(NSUInteger)offset pickHandler:(void (^)(NSDictionary *assignment))handler;
@end

static NSString *fmtPrice(NSInteger price) {
    if (price >= 1000000) return [NSString stringWithFormat:@"%.1fM", (double)price/1000000];
    if (price >= 1000) return [NSString stringWithFormat:@"%.1fk", (double)price/1000];
    return [NSString stringWithFormat:@"%ldđ", (long)price];
}

static void (^gReloadJSCB)(void) = nil;
static NSMutableArray<UIAlertController *> *gPresentationQueue = nil;
static BOOL gPresentationPumpScheduled = NO;
static const NSInteger kToastViewTag = 658204;
static NSString * const kAPFSkippedAssignmentHistoryKey = @"APFSkippedAssignmentHistory";

@implementation APFMenu

+ (void)initialize {
    if (self == [APFMenu class]) {
        // v6.6.4 no longer stores successful-pick history locally. Remove the legacy key.
        [[NSUserDefaults standardUserDefaults] removeObjectForKey:@"APFPickSuccessHistory"];
        [[NSNotificationCenter defaultCenter] addObserver:self
            selector:@selector(applicationDidBecomeActive:)
            name:UIApplicationDidBecomeActiveNotification object:nil];
    }
}

+ (void)applicationDidBecomeActive:(NSNotification *)note {
    [self schedulePresentationPump];
}

+ (UIWindow *)keyWindow {
    if (@available(iOS 13.0, *)) {
        for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
            if ([s isKindOfClass:[UIWindowScene class]])
                for (UIWindow *w in ((UIWindowScene *)s).windows)
                    if (w.isKeyWindow) return w;
    }
    // FIX: app dùng AppDelegate.window (không có Scene) -> connectedScenes rỗng => menu/alert không hiện
    id<UIApplicationDelegate> d = UIApplication.sharedApplication.delegate;
    if ([d respondsToSelector:@selector(window)] && d.window) return d.window;
    return UIApplication.sharedApplication.windows.firstObject;
}

+ (UIViewController *)topVC {
    UIWindow *window = [self keyWindow];
    UIViewController *current = window.rootViewController;
    if (!current) return nil;

    // Stop underneath alerts. Their action handlers run before the dismissal animation
    // has fully completed, so they must never be used as the next alert's presenter.
    while (current.presentedViewController) {
        UIViewController *presented = current.presentedViewController;
        if ([presented isKindOfClass:[UIAlertController class]] || presented.isBeingDismissed) break;
        current = presented;
    }
    if ([current isKindOfClass:[UINavigationController class]]) {
        UIViewController *visible = ((UINavigationController *)current).visibleViewController;
        if (visible) current = visible;
    } else if ([current isKindOfClass:[UITabBarController class]]) {
        UIViewController *selected = ((UITabBarController *)current).selectedViewController;
        if (selected) current = selected;
    }
    return current;
}

+ (void)schedulePresentationPump {
    if (gPresentationPumpScheduled) return;
    gPresentationPumpScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.12 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        gPresentationPumpScheduled = NO;
        [self pumpPresentationQueue];
    });
}

+ (void)pumpPresentationQueue {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self pumpPresentationQueue]; });
        return;
    }
    if (gPresentationQueue.count == 0) return;
    // Keep queued assignment prompts while backgrounded without spinning a timer forever.
    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
    UIViewController *presenter = [self topVC];
    if (!presenter || !presenter.isViewLoaded || !presenter.view.window) {
        [self schedulePresentationPump];
        return;
    }
    // Wait for any previous alert or modal transition to actually finish. This avoids
    // stacking presentation calls during the Pick-lẻ sheet's dismissal animation.
    if (presenter.presentedViewController || presenter.isBeingPresented || presenter.isBeingDismissed || presenter.transitionCoordinator) {
        [self schedulePresentationPump];
        return;
    }

    UIAlertController *next = gPresentationQueue.firstObject;
    [gPresentationQueue removeObjectAtIndex:0];
    if (next.preferredStyle == UIAlertControllerStyleActionSheet && next.popoverPresentationController) {
        next.popoverPresentationController.sourceView = presenter.view;
        next.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(presenter.view.bounds),
            CGRectGetMidY(presenter.view.bounds), 1, 1);
    }
    [presenter presentViewController:next animated:YES completion:^{
        // Process any additional queued presentation only after this one has been handled.
        if (gPresentationQueue.count > 0) [self schedulePresentationPump];
    }];
}

+ (void)requestNotificationPermission {
    UNUserNotificationCenter *c = [UNUserNotificationCenter currentNotificationCenter];
    [c requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
        completionHandler:^(BOOL granted, NSError *e) {
            NSLog(@"[AutoPick] 🔔 Permission: %@", granted ? @"OK" : @"NO");
        }];
}

+ (void)showSystemNotification:(NSString *)title body:(NSString *)body id:(NSString *)ident {
    @try {
        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = title;
        content.body = body;
        content.sound = [UNNotificationSound defaultSound];
        UNTimeIntervalNotificationTrigger *t = [UNTimeIntervalNotificationTrigger
            triggerWithTimeInterval:0.1 repeats:NO];
        UNNotificationRequest *req = [UNNotificationRequest
            requestWithIdentifier:(ident ?: [[NSUUID UUID] UUIDString])
            content:content trigger:t];
        [[UNUserNotificationCenter currentNotificationCenter]
            addNotificationRequest:req withCompletionHandler:^(NSError *e) {}];
    } @catch(NSException *e) {
        [[APFLogManager sharedManager] logWarning:@"NOTIFY.MATCH_BUILD_FAILED" message:(e.reason ?: @"Không thể tạo thông báo match") source:@"NOTIFY" context:nil];
    }
}

+ (void)presentSheet:(UIAlertController *)controller {
    if (!controller) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!gPresentationQueue) gPresentationQueue = [NSMutableArray array];
        // Coalesce exact duplicates if a tap/retry accidentally requests the same sheet twice.
        for (UIAlertController *queued in gPresentationQueue) {
            if ([queued.title isEqualToString:controller.title] &&
                queued.preferredStyle == controller.preferredStyle) return;
        }
        [gPresentationQueue addObject:controller];
        [self pumpPresentationQueue];
    });
}

+ (void)presentMenu {
    APFPrefs *p = [APFPrefs shared];
    UIAlertController *s = [UIAlertController alertControllerWithTitle:@"⚡ AutoPick Pro v6.6.7"
        message:[NSString stringWithFormat:@"Trạng thái: %@", p.enabled ? @"BẬT" : @"TẮT"]
        preferredStyle:UIAlertControllerStyleActionSheet];
    [s addAction:[UIAlertAction actionWithTitle:(p.enabled ? @"🔴 TẮT AutoPick" : @"🟢 BẬT AutoPick")
        style:UIAlertActionStyleDestructive handler:^(UIAlertAction *a) {
            p.enabled = !p.enabled; [p save];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:@"⚙️ Cấu hình" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *a) { [self detailMenu]; }]];
    [s addAction:[UIAlertAction actionWithTitle:@"🎯 Bộ lọc" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *a) { [self filterMenu]; }]];
    [s addAction:[UIAlertAction actionWithTitle:@"🔔 Thông báo" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *a) { [self notifyMenu]; }]];
    [s addAction:[UIAlertAction actionWithTitle:@"📋 Assignment đã bỏ qua" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *a) {
            [self showSkippedAssignmentHistoryWithPickHandler:^(NSDictionary *assignment) {
                [[FridaController shared] repickAssignment:assignment];
            }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:@"⚡ Test Free-Pick" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *a) { [[FridaController shared] previewLiveApiTest:@"free_pick"]; }]];
    [s addAction:[UIAlertAction actionWithTitle:@"⚡ Test MPICK" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *a) { [[FridaController shared] previewLiveApiTest:@"mpick"]; }]];

    [s addAction:[UIAlertAction actionWithTitle:@"🔄 Reload JS từ server"
        style:UIAlertActionStyleDestructive handler:^(UIAlertAction *a) {
        UIAlertController *confirm = [UIAlertController
            alertControllerWithTitle:@"🔄 Reload JS"
            message:@"Xoá cache và tải JS mới từ server?\nSau đó cần SPAWN lại."
            preferredStyle:UIAlertControllerStyleAlert];
        [confirm addAction:[UIAlertAction actionWithTitle:@"Huỷ"
            style:UIAlertActionStyleCancel handler:nil]];
        [confirm addAction:[UIAlertAction actionWithTitle:@"Đồng ý"
            style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) {
            if (gReloadJSCB) gReloadJSCB();
            [self toast:@"Đã clear cache — spawn lại để tải JS mới"];
        }]];
        [self presentSheet:confirm];
    }]];

    [s addAction:[UIAlertAction actionWithTitle:@"🔄 Reset" style:UIAlertActionStyleDestructive
        handler:^(UIAlertAction *a) { [p reset]; [self toast:@"Đã reset"]; }]];
    [s addAction:[UIAlertAction actionWithTitle:@"Đóng" style:UIAlertActionStyleCancel handler:nil]];
    [self presentSheet:s];
}

+ (void)setReloadJSCallback:(void (^)(void))cb { gReloadJSCB = [cb copy]; }

+ (void)detailMenu {
    APFPrefs *p = [APFPrefs shared];
    UIAlertController *s = [UIAlertController alertControllerWithTitle:@"⚙️ Cấu hình"
        message:nil preferredStyle:UIAlertControllerStyleActionSheet];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Auto refresh: %@", p.autoRefresh ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.autoRefresh = !p.autoRefresh; [p save]; [self detailMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Auto pick: %@", p.autoPick ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.autoPick = !p.autoPick; [p save]; [self detailMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Dừng sau pick: %@", p.stopAfterPick ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.stopAfterPick = !p.stopAfterPick; [p save]; [self detailMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📦 Pick lẻ ALL trong chùm: %@", p.pickAllSinglesInGroup ? @"BẬT" : @"TẮT"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.pickAllSinglesInGroup = !p.pickAllSinglesInGroup;
            [p save];
            [self detailMenu];
        }]];
    if (p.pickAllSinglesInGroup) {
        [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📏 Km tối thiểu chùm: %.1f km", (double)p.pickAllSinglesInGroupMinDistance/1000.0]
            style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
                [self numberInput:@"Km tối thiểu chùm (m, 0=tắt)" val:p.pickAllSinglesInGroupMinDistance min:0 max:100000
                    cb:^(NSInteger v) { p.pickAllSinglesInGroupMinDistance = v; [p save]; [self detailMenu]; }];
            }]];
    }
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"🚫 Chặn URL chính xác: %@", p.blockedURL.length ? p.blockedURL : @"TẮT"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            NSString *current = p.blockedURL ?: @"";
            [self textInput:@"URL chặn chính xác (để trống để tắt)" val:current cb:^(NSString *value) {
                NSString *trimmed = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if (trimmed.length > 0) {
                    NSURLComponents *components = [NSURLComponents componentsWithString:trimmed];
                    BOOL valid = components && ([components.scheme.lowercaseString isEqualToString:@"http"] || [components.scheme.lowercaseString isEqualToString:@"https"]) && components.host.length > 0;
                    if (!valid) {
                        [self toast:@"URL không hợp lệ. Hãy nhập URL đầy đủ bắt đầu bằng http:// hoặc https://"];
                        return;
                    }
                }
                p.blockedURL = trimmed;
                [p save];
                [self toast:trimmed.length ? @"Đã lưu chặn URL chính xác (chỉ URL đầy đủ này)" : @"Đã tắt chặn URL"];
                [self detailMenu];
            }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📤 Lấy dữ liệu đơn lên host: %@", p.orderDataUploadEnabled ? @"BẬT" : @"TẮT"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.orderDataUploadEnabled = !p.orderDataUploadEnabled;
            [p save];
            if (p.orderDataUploadEnabled && p.orderDataUploadToken.length == 0) {
                [self toast:@"Đã bật lấy dữ liệu đơn. Hãy nhập token khớp với PHP để upload hoạt động."];
            }
            [self detailMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"🔑 Token upload: %@", p.orderDataUploadToken.length ? @"ĐÃ ĐẶT" : @"CHƯA ĐẶT"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self textInput:@"Token bí mật upload (phải khớp với PHP, tối thiểu 32 ký tự)" val:p.orderDataUploadToken ?: @"" cb:^(NSString *value) {
                NSString *token = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if (token.length > 0 && token.length < 32) {
                    [self toast:@"Token phải có ít nhất 32 ký tự; hãy dùng secret ngẫu nhiên."];
                    return;
                }
                p.orderDataUploadToken = token;
                [p save];
                [self toast:p.orderDataUploadToken.length ? @"Đã lưu token upload" : @"Đã xóa token upload"];
                [self detailMenu];
            }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Logging INFO: %@", p.loggingEnabled ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.loggingEnabled = !p.loggingEnabled; [p save];
            [[APFLogManager sharedManager] logSuccess:@"CONFIG.LOGGING_LEVEL_CHANGED" message:(p.loggingEnabled ? @"Đã bật log INFO" : @"Đã tắt log INFO; WARNING/ERROR/SUCCESS vẫn được lưu") source:@"CONFIG" context:nil];
            [self detailMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Verbose log: %@", p.verboseLog ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.verboseLog = !p.verboseLog; [p save]; [self detailMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"⏱ Chu kỳ: %ldms", (long)p.refreshIntervalMs]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Chu kỳ refresh (100-10000ms)" val:p.refreshIntervalMs min:100 max:10000
                cb:^(NSInteger v) { p.refreshIntervalMs = v; [p save]; [self detailMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📡 Bán kính: %ldm", (long)p.requestMaxDistance]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Bán kính (500-50000m)" val:p.requestMaxDistance min:500 max:50000
                cb:^(NSInteger v) { p.requestMaxDistance = v; [p save]; [self detailMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Số đơn tối đa: %ld", (long)p.maxOrdersPerSession]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Số đơn" val:p.maxOrdersPerSession min:1 max:100
                cb:^(NSInteger v) { p.maxOrdersPerSession = v; [p save]; [self detailMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Cooldown: %.1fs", p.cooldown]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Cooldown x10 (3 = 0,3s)" val:(NSInteger)(p.cooldown*10) min:3 max:100
                cb:^(NSInteger v) { p.cooldown = v/10.0; [p save]; [self detailMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:@"⬅️ Quay lại" style:UIAlertActionStyleCancel
        handler:^(UIAlertAction *a) { [self presentMenu]; }]];
    [self presentSheet:s];
}

+ (void)filterMenu {
    APFPrefs *p = [APFPrefs shared];
    UIAlertController *s = [UIAlertController alertControllerWithTitle:@"🎯 Bộ lọc"
        message:nil preferredStyle:UIAlertControllerStyleActionSheet];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"💰 Giá min: %@", fmtPrice(p.minPrice)]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Giá min" val:p.minPrice min:0 max:10000000
                cb:^(NSInteger v) { p.minPrice = v; [p save]; [self filterMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"💰 Giá max: %@", p.maxPrice > 0 ? fmtPrice(p.maxPrice) : @"off"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Giá max (0=off)" val:p.maxPrice min:0 max:10000000
                cb:^(NSInteger v) { p.maxPrice = v; [p save]; [self filterMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📏 Km min: %.1f", (double)p.minDistance/1000]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Km min (m)" val:p.minDistance min:0 max:100000
                cb:^(NSInteger v) { p.minDistance = v; [p save]; [self filterMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📏 Km max: %.1f", (double)p.maxDistance/1000]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"Km max (m)" val:p.maxDistance min:0 max:200000
                cb:^(NSInteger v) { p.maxDistance = v; [p save]; [self filterMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"💵 COD min: %@", fmtPrice(p.minCOD)]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"COD min" val:p.minCOD min:0 max:100000000
                cb:^(NSInteger v) { p.minCOD = v; [p save]; [self filterMenu]; }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"💵 COD max: %@", p.maxCOD > 0 ? fmtPrice(p.maxCOD) : @"off"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self numberInput:@"COD max (0=off)" val:p.maxCOD min:0 max:100000000
                cb:^(NSInteger v) { p.maxCOD = v; [p save]; [self filterMenu]; }];
        }]];
    NSString *catStr = p.preferredCategories.count > 0
        ? [[p.preferredCategories valueForKey:@"description"] componentsJoinedByString:@","]
        : @"tất cả";
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📦 Loại: %@", catStr]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self textInput:@"Loại (số,phẩy | 'tất cả')" val:catStr cb:^(NSString *v) {
                if ([v isEqualToString:@"tất cả"] || v.length == 0) p.preferredCategories = @[];
                else {
                    NSMutableArray *arr = [NSMutableArray array];
                    for (NSString *x in [v componentsSeparatedByString:@","])
                        [arr addObject:@([x integerValue])];
                    p.preferredCategories = arr;
                }
                [p save]; [self filterMenu];
            }];
        }]];
    NSString *districtStr = p.preferredDistricts.count > 0
        ? [p.preferredDistricts componentsJoinedByString:@", "] : @"(tất cả)";
    NSString *modeStr = @"off";
    if (p.districtFilterMode == 1) modeStr = @"điểm lấy";
    else if (p.districtFilterMode == 2) modeStr = @"điểm giao";
    else if (p.districtFilterMode == 3) modeStr = @"cả 2";
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📍 Quận: %@", districtStr]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self textInput:@"Quận (cách phẩy)" val:districtStr cb:^(NSString *v) {
                if ([v isEqualToString:@"(tất cả)"] || v.length == 0) p.preferredDistricts = @[];
                else {
                    NSMutableArray *arr = [NSMutableArray array];
                    for (NSString *x in [v componentsSeparatedByString:@","]) {
                        NSString *trim = [x stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
                        if (trim.length > 0) [arr addObject:trim];
                    }
                    p.preferredDistricts = arr;
                }
                [p save]; [self filterMenu];
            }];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"🔍 Lọc theo: %@", modeStr]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            UIAlertController *m = [UIAlertController alertControllerWithTitle:@"Lọc quận theo"
                message:nil preferredStyle:UIAlertControllerStyleActionSheet];
            [m addAction:[UIAlertAction actionWithTitle:@"❌ Tắt" style:UIAlertActionStyleDefault
                handler:^(UIAlertAction *x) { p.districtFilterMode = 0; [p save]; [self filterMenu]; }]];
            [m addAction:[UIAlertAction actionWithTitle:@"📍 Điểm lấy" style:UIAlertActionStyleDefault
                handler:^(UIAlertAction *x) { p.districtFilterMode = 1; [p save]; [self filterMenu]; }]];
            [m addAction:[UIAlertAction actionWithTitle:@"🏁 Điểm giao" style:UIAlertActionStyleDefault
                handler:^(UIAlertAction *x) { p.districtFilterMode = 2; [p save]; [self filterMenu]; }]];
            [m addAction:[UIAlertAction actionWithTitle:@"✅ Cả 2" style:UIAlertActionStyleDefault
                handler:^(UIAlertAction *x) { p.districtFilterMode = 3; [p save]; [self filterMenu]; }]];
            [m addAction:[UIAlertAction actionWithTitle:@"Hủy" style:UIAlertActionStyleCancel handler:nil]];
            [self presentSheet:m];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:@"⬅️ Quay lại" style:UIAlertActionStyleCancel
        handler:^(UIAlertAction *a) { [self presentMenu]; }]];
    [self presentSheet:s];
}

+ (void)notifyMenu {
    APFPrefs *p = [APFPrefs shared];
    UIAlertController *s = [UIAlertController alertControllerWithTitle:@"🔔 Thông báo"
        message:nil preferredStyle:UIAlertControllerStyleActionSheet];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📱 Hệ thống: %@", p.systemNotify ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.systemNotify = !p.systemNotify; [p save];
            if (p.systemNotify) [self requestNotificationPermission];
            [self notifyMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"💬 Popup app: %@", p.notifyOnMatch ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.notifyOnMatch = !p.notifyOnMatch; [p save]; [self notifyMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📦 Popup khi hệ thống gán: %@", p.notifyOnAssignment ? @"BẬT" : @"TẮT"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.notifyOnAssignment = !p.notifyOnAssignment; [p save]; [self notifyMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"✅ Pick OK: %@", p.notifyOnSuccess ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.notifyOnSuccess = !p.notifyOnSuccess; [p save]; [self notifyMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"🔊 Âm thanh: %@", p.soundOnMatch ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.soundOnMatch = !p.soundOnMatch; [p save]; [self notifyMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"📳 Rung: %@", p.vibrateOnMatch ? @"✅" : @"❌"]
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            p.vibrateOnMatch = !p.vibrateOnMatch; [p save]; [self notifyMenu];
        }]];
    [s addAction:[UIAlertAction actionWithTitle:@"🧪 Test thông báo"
        style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
        [self requestNotificationPermission];
        dispatch_async(dispatch_get_main_queue(), ^{
            UIViewController *t = [self topVC];
            if (t) {
                UIAlertController *ok = [UIAlertController
                    alertControllerWithTitle:@"🧪 TEST OK"
                    message:@"Đã bắn notification — xem banner trên cùng màn hình"
                    preferredStyle:UIAlertControllerStyleAlert];
                [ok addAction:[UIAlertAction actionWithTitle:@"OK"
                    style:UIAlertActionStyleDefault handler:nil]];
                [self presentSheet:ok];
            }
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
            dispatch_get_main_queue(), ^{
            AudioServicesPlaySystemSound(1007);
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate);
            [self showSystemNotification:@"⚡ AutoPick Test"
                                     body:@"Đây là thông báo test"
                                       id:[NSString stringWithFormat:@"test_%ld",
                                           (long)[[NSDate date] timeIntervalSince1970]]];
        });
    }]];
    [s addAction:[UIAlertAction actionWithTitle:@"⬅️ Quay lại" style:UIAlertActionStyleCancel
        handler:^(UIAlertAction *a) { [self presentMenu]; }]];
    [self presentSheet:s];
}

+ (void)numberInput:(NSString *)title val:(NSInteger)v min:(NSInteger)min max:(NSInteger)max
                 cb:(void (^)(NSInteger))cb {
    UIViewController *t = [self topVC]; if (!t) return;
    UIAlertController *a = [UIAlertController alertControllerWithTitle:title
        message:[NSString stringWithFormat:@"(%ld - %ld)", (long)min, (long)max]
        preferredStyle:UIAlertControllerStyleAlert];
    [a addTextFieldWithConfigurationHandler:^(UITextField *tf) {
        tf.keyboardType = UIKeyboardTypeNumberPad;
        tf.text = [NSString stringWithFormat:@"%ld", (long)v];
    }];
    [a addAction:[UIAlertAction actionWithTitle:@"Hủy" style:UIAlertActionStyleCancel handler:nil]];
    [a addAction:[UIAlertAction actionWithTitle:@"Lưu" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *x) {
            NSInteger n = [a.textFields.firstObject.text integerValue];
            if (n < min) n = min;
            if (n > max) n = max;
            cb(n);
        }]];
    [self presentSheet:a];
}

+ (void)textInput:(NSString *)title val:(NSString *)v cb:(void (^)(NSString *))cb {
    UIViewController *t = [self topVC]; if (!t) return;
    UIAlertController *a = [UIAlertController alertControllerWithTitle:title
        message:nil preferredStyle:UIAlertControllerStyleAlert];
    [a addTextFieldWithConfigurationHandler:^(UITextField *tf) {
        tf.text = v;
        tf.autocapitalizationType = UITextAutocapitalizationTypeNone;
        tf.autocorrectionType = UITextAutocorrectionTypeNo;
        if ([title.lowercaseString containsString:@"url"]) tf.keyboardType = UIKeyboardTypeURL;
        if ([title.lowercaseString containsString:@"token"]) tf.secureTextEntry = YES;
    }];
    [a addAction:[UIAlertAction actionWithTitle:@"Hủy" style:UIAlertActionStyleCancel handler:nil]];
    [a addAction:[UIAlertAction actionWithTitle:@"Lưu" style:UIAlertActionStyleDefault
        handler:^(UIAlertAction *x) { cb(a.textFields.firstObject.text ?: @""); }]];
    [self presentSheet:a];
}

+ (void)toast:(NSString *)message {
    if (message.length == 0) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController *host = [self topVC];
        if (!host.isViewLoaded || !host.view.window) return;
        UIView *oldToast = [host.view viewWithTag:kToastViewTag];
        [oldToast.layer removeAllAnimations];
        [oldToast removeFromSuperview];

        UIView *container = [[UIView alloc] init];
        container.tag = kToastViewTag;
        container.translatesAutoresizingMaskIntoConstraints = NO;
        container.userInteractionEnabled = NO;
        container.backgroundColor = [UIColor colorWithWhite:0.10 alpha:0.94];
        container.layer.cornerRadius = 13.0;
        container.layer.masksToBounds = YES;
        container.alpha = 0.0;
        [host.view addSubview:container];

        UILabel *label = [[UILabel alloc] init];
        label.translatesAutoresizingMaskIntoConstraints = NO;
        label.text = message;
        label.textColor = UIColor.whiteColor;
        label.font = [UIFont systemFontOfSize:14 weight:UIFontWeightMedium];
        label.numberOfLines = 0;
        label.textAlignment = NSTextAlignmentCenter;
        [container addSubview:label];

        UILayoutGuide *safe = host.view.safeAreaLayoutGuide;
        [NSLayoutConstraint activateConstraints:@[
            [container.centerXAnchor constraintEqualToAnchor:host.view.centerXAnchor],
            [container.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-18],
            [container.widthAnchor constraintLessThanOrEqualToAnchor:host.view.widthAnchor multiplier:0.88],
            [label.topAnchor constraintEqualToAnchor:container.topAnchor constant:11],
            [label.bottomAnchor constraintEqualToAnchor:container.bottomAnchor constant:-11],
            [label.leadingAnchor constraintEqualToAnchor:container.leadingAnchor constant:15],
            [label.trailingAnchor constraintEqualToAnchor:container.trailingAnchor constant:-15]
        ]];
        container.transform = CGAffineTransformMakeTranslation(0, 8);
        [UIView animateWithDuration:0.20 animations:^{
            container.alpha = 1.0;
            container.transform = CGAffineTransformIdentity;
        }];
        __weak UIView *weakContainer = container;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.9 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            UIView *toastView = weakContainer;
            if (!toastView || toastView.superview != host.view) return;
            [UIView animateWithDuration:0.18 animations:^{ toastView.alpha = 0.0; }
                completion:^(BOOL finished) { [toastView removeFromSuperview]; }];
        });
    });
}

#pragma mark - Skipped Assignment history

+ (NSMutableArray<NSDictionary *> *)mutableAssignmentHistory {
    id stored = [[NSUserDefaults standardUserDefaults] objectForKey:kAPFSkippedAssignmentHistoryKey];
    if (![stored isKindOfClass:[NSArray class]]) return [NSMutableArray array];
    NSMutableArray *records = [NSMutableArray array];
    for (id row in (NSArray *)stored) if ([row isKindOfClass:[NSDictionary class]]) [records addObject:row];
    return records;
}

+ (void)persistAssignmentHistory:(NSArray<NSDictionary *> *)records {
    NSArray *bounded = records.count > 50 ? [records subarrayWithRange:NSMakeRange(0, 50)] : records;
    [[NSUserDefaults standardUserDefaults] setObject:bounded ?: @[] forKey:kAPFSkippedAssignmentHistoryKey];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (void)saveSkippedAssignment:(NSDictionary *)assignment {
    if (![assignment isKindOfClass:[NSDictionary class]]) return;
    NSString *assignmentId = [assignment[@"assignmentId"] isKindOfClass:[NSString class]]
        ? assignment[@"assignmentId"] : [assignment[@"assignmentId"] description];
    if (assignmentId.length == 0) return;
    NSArray *rawIds = [assignment[@"orderIds"] isKindOfClass:[NSArray class]] ? assignment[@"orderIds"] : @[];
    NSMutableArray *orderIds = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    for (id raw in rawIds) {
        long long value = [raw longLongValue];
        if (value <= 0) continue;
        NSNumber *number = @(value);
        if (![seen containsObject:number]) { [seen addObject:number]; [orderIds addObject:number]; }
    }
    NSMutableDictionary *record = [NSMutableDictionary dictionary];
    record[@"assignmentId"] = assignmentId;
    record[@"orderIds"] = orderIds;
    record[@"expectedOrderCount"] = @([assignment[@"expectedOrderCount"] respondsToSelector:@selector(integerValue)]
        ? [assignment[@"expectedOrderCount"] integerValue] : orderIds.count);
    record[@"isGroup"] = @([assignment[@"isGroup"] boolValue] || orderIds.count > 1);
    record[@"incompleteGroup"] = @([assignment[@"incompleteGroup"] boolValue]);
    record[@"price"] = @([assignment[@"price"] longLongValue]);
    record[@"distance"] = @([assignment[@"distance"] longLongValue]);
    if ([assignment[@"preGroupCode"] isKindOfClass:[NSString class]]) record[@"preGroupCode"] = assignment[@"preGroupCode"];
    record[@"status"] = @"SKIPPED";
    record[@"detail"] = @"Người dùng đã bấm Bỏ qua; chưa gửi request Pick.";
    record[@"createdAt"] = @([[NSDate date] timeIntervalSince1970]);
    record[@"updatedAt"] = record[@"createdAt"];

    NSMutableArray *history = [self mutableAssignmentHistory];
    NSIndexSet *duplicates = [history indexesOfObjectsPassingTest:^BOOL(NSDictionary *obj, NSUInteger idx, BOOL *stop) {
        return [[obj[@"assignmentId"] description] isEqualToString:assignmentId];
    }];
    if (duplicates.count) [history removeObjectsAtIndexes:duplicates];
    [history insertObject:record atIndex:0];
    [self persistAssignmentHistory:history];
    [[APFLogManager sharedManager] logInfo:@"ASSIGNMENT.HISTORY.SAVED"
        message:@"Đã lưu Assignment người dùng bỏ qua" source:@"ASSIGNMENT"
        context:@{@"assignment_id": assignmentId, @"order_count": @(orderIds.count)}];
}

+ (void)updateAssignmentHistory:(NSString *)assignmentId status:(NSString *)status detail:(NSString *)detail {
    if (assignmentId.length == 0 || status.length == 0) return;
    NSMutableArray *history = [self mutableAssignmentHistory];
    BOOL changed = NO;
    for (NSUInteger i = 0; i < history.count; i++) {
        NSDictionary *old = history[i];
        if (![[old[@"assignmentId"] description] isEqualToString:assignmentId]) continue;
        NSMutableDictionary *updated = [old mutableCopy];
        updated[@"status"] = status;
        updated[@"detail"] = detail ?: @"";
        updated[@"updatedAt"] = @([[NSDate date] timeIntervalSince1970]);
        history[i] = updated;
        changed = YES;
        break;
    }
    if (changed) [self persistAssignmentHistory:history];
}

  + (void)showSkippedAssignmentHistoryWithPickHandler:(void (^)(NSDictionary *))handler {
    [self showSkippedAssignmentHistoryFromOffset:0 pickHandler:handler];
}

+ (void)showSkippedAssignmentHistoryFromOffset:(NSUInteger)offset pickHandler:(void (^)(NSDictionary *assignment))handler {
    NSArray<NSDictionary *> *history = [[self mutableAssignmentHistory] copy];
    const NSUInteger pageSize = 12;
    NSUInteger total = history.count;
    NSUInteger start = MIN(offset, total);
    NSUInteger end = MIN(start + pageSize, total);
    NSUInteger page = start / pageSize + 1;
    NSUInteger pages = MAX((NSUInteger)1, (total + pageSize - 1) / pageSize);
    NSString *message = total
        ? [NSString stringWithFormat:@"Có %lu Assignment đã lưu · Trang %lu/%lu", (unsigned long)total, (unsigned long)page, (unsigned long)pages]
        : @"Chưa có Assignment nào bị bỏ qua. Khi bạn bấm Bỏ qua ở popup gán đơn, Assignment sẽ được lưu tại đây.";
    UIAlertController *list = [UIAlertController alertControllerWithTitle:@"📋 Assignment đã bỏ qua"
        message:message preferredStyle:UIAlertControllerStyleActionSheet];

    for (NSUInteger i = start; i < end; i++) {
        NSDictionary *record = history[i];
        NSString *aid = [record[@"assignmentId"] description] ?: @"?";
        NSArray *ids = [record[@"orderIds"] isKindOfClass:[NSArray class]] ? record[@"orderIds"] : @[];
        NSString *status = [record[@"status"] description] ?: @"SKIPPED";
        NSString *mark = [status isEqualToString:@"PICKED"] ? @"✅" :
            ([status isEqualToString:@"PICKING"] ? @"⏳" :
            ([status isEqualToString:@"UNKNOWN"] || [status isEqualToString:@"PARTIAL"] ? @"⚠️" :
            ([status isEqualToString:@"FAILED"] ? @"❌" : @"↻")));
        NSString *title = [NSString stringWithFormat:@"%@ · %@ · %lu đơn", mark, aid, (unsigned long)ids.count];
        [list addAction:[UIAlertAction actionWithTitle:title style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            NSMutableString *detail = [NSMutableString stringWithFormat:@"Assignment ID: %@\nSố đơn: %lu\nMã đơn: %@\nTrạng thái: %@",
                aid, (unsigned long)ids.count, ids.count ? [[ids valueForKey:@"description"] componentsJoinedByString:@", "] : @"không có", status];
            if ([record[@"price"] longLongValue] > 0) [detail appendFormat:@"\nTổng nhận dự kiến: %@", fmtPrice([record[@"price"] integerValue])];
            if ([record[@"distance"] longLongValue] > 0) [detail appendFormat:@"\nQuãng đường: %.1f km", [record[@"distance"] doubleValue] / 1000.0];
            if ([record[@"detail"] isKindOfClass:[NSString class]] && [record[@"detail"] length]) [detail appendFormat:@"\n\n%@", record[@"detail"]];
            NSDate *created = [NSDate dateWithTimeIntervalSince1970:[record[@"createdAt"] doubleValue]];
            NSDateFormatter *df = [[NSDateFormatter alloc] init]; df.dateFormat = @"HH:mm dd/MM/yyyy";
            if (created.timeIntervalSince1970 > 0) [detail appendFormat:@"\nLưu lúc: %@", [df stringFromDate:created]];

            UIAlertController *info = [UIAlertController alertControllerWithTitle:[NSString stringWithFormat:@"Assignment %@", aid]
                message:detail preferredStyle:UIAlertControllerStyleAlert];
            [info addAction:[UIAlertAction actionWithTitle:@"Đóng" style:UIAlertActionStyleCancel handler:nil]];
            [info addAction:[UIAlertAction actionWithTitle:@"Xóa khỏi lịch sử" style:UIAlertActionStyleDestructive handler:^(UIAlertAction *x) {
                NSMutableArray *current = [self mutableAssignmentHistory];
                NSIndexSet *matches = [current indexesOfObjectsPassingTest:^BOOL(NSDictionary *obj, NSUInteger idx, BOOL *stop) {
                    return [[obj[@"assignmentId"] description] isEqualToString:aid];
                }];
                if (matches.count) { [current removeObjectsAtIndexes:matches]; [self persistAssignmentHistory:current]; }
            }]];
            BOOL canRetry = [status isEqualToString:@"SKIPPED"] || [status isEqualToString:@"FAILED"];
            if (canRetry && ids.count > 0 && ![record[@"incompleteGroup"] boolValue]) {
                [info addAction:[UIAlertAction actionWithTitle:(ids.count > 1 ? @"↻ Pick lẻ ALL" : @"↻ Pick lại đơn")
                    style:UIAlertActionStyleDefault handler:^(UIAlertAction *x) {
                    if (![[FridaController shared] isAttached]) {
                        UIAlertController *notReady = [UIAlertController alertControllerWithTitle:@"⚠️ Chưa kết nối"
                            message:@"Hãy Attach/Spawn ứng dụng tài xế trước khi Pick lại Assignment." preferredStyle:UIAlertControllerStyleAlert];
                        [notReady addAction:[UIAlertAction actionWithTitle:@"Đóng" style:UIAlertActionStyleDefault handler:nil]];
                        [self presentSheet:notReady];
                        return;
                    }
                    if (handler) handler(record);
                }]];
            }
            [self presentSheet:info];
        }]];
    }

    if (offset > 0) {
        NSUInteger previous = offset >= pageSize ? offset - pageSize : 0;
        [list addAction:[UIAlertAction actionWithTitle:@"← Trang trước" style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self showSkippedAssignmentHistoryFromOffset:previous pickHandler:handler];
        }]];
    }
    if (end < total) {
        [list addAction:[UIAlertAction actionWithTitle:@"Assignment cũ hơn →" style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
            [self showSkippedAssignmentHistoryFromOffset:end pickHandler:handler];
        }]];
    }
    [list addAction:[UIAlertAction actionWithTitle:@"Đóng" style:UIAlertActionStyleCancel handler:nil]];
    [self presentSheet:list];
}

#pragma mark - Assignment prompts and notifications

+ (void)showAssignmentPrompt:(NSDictionary *)assignment decisionHandler:(void (^)(NSString *, NSString *))handler {
    if (![assignment isKindOfClass:[NSDictionary class]]) return;
    if (![APFPrefs shared].notifyOnAssignment) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *assignmentId = [assignment[@"assignmentId"] description];
        NSArray *ids = [assignment[@"orderIds"] isKindOfClass:[NSArray class]] ? assignment[@"orderIds"] : @[];
        NSInteger expectedCount = [assignment[@"expectedOrderCount"] respondsToSelector:@selector(integerValue)]
            ? [assignment[@"expectedOrderCount"] integerValue] : (NSInteger)ids.count;
        BOOL isGroup = [assignment[@"isGroup"] boolValue] || expectedCount > 1 || ids.count > 1;
        NSString *baseTitle = isGroup ? @"📦 Có chùm đơn vừa được gán" : @"🛵 Có đơn vừa được gán";
        NSString *title = assignmentId.length ? [NSString stringWithFormat:@"%@ · %@", baseTitle, assignmentId] : baseTitle;
        NSMutableString *message = [NSMutableString string];
        [message appendFormat:@"Assignment ID: %@", assignmentId.length ? assignmentId : @"không rõ"];
        BOOL incompleteGroup = [assignment[@"incompleteGroup"] boolValue] || (isGroup && expectedCount > ids.count);
        if (ids.count > 0) {
            [message appendFormat:@"\nSố đơn đọc được: %lu/%ld", (unsigned long)ids.count, (long)expectedCount];
            NSUInteger maxShow = MIN(ids.count, 6);
            NSMutableArray *displayIds = [NSMutableArray array];
            for (NSUInteger i = 0; i < maxShow; i++) [displayIds addObject:[ids[i] description]];
            [message appendFormat:@"\nMã đơn: %@%@", [displayIds componentsJoinedByString:@", "], ids.count > maxShow ? @", …" : @""];
            NSInteger price = [assignment[@"price"] integerValue];
            if (price > 0) [message appendFormat:@"\nTổng nhận dự kiến: %@", fmtPrice(price)];
            NSInteger distance = [assignment[@"distance"] integerValue];
            if (distance > 0) [message appendFormat:@"\nTổng quãng đường: %.1f km", (double)distance / 1000.0];
        } else {
            [message appendString:@"\nKhông đọc được delivery_order_id hợp lệ; chưa thể gửi thao tác pick."];
        }
        if (incompleteGroup) [message appendString:@"\nDữ liệu chùm chưa đủ mã đơn; thao tác pick đã bị khóa để tránh chỉ lấy một phần chùm."];
        BOOL canPickRequest = ![assignment[@"canPickRequest"] respondsToSelector:@selector(boolValue)] || [assignment[@"canPickRequest"] boolValue];
        if (!canPickRequest) [message appendString:@"\nChưa có request context từ ứng dụng; cần tải lại thông tin đơn trước khi pick."];
        // iOS cannot present an in-app UIAlertController over another foreground app.
        // When AutoPick is backgrounded, send a local notification regardless of the
        // generic notification toggle; keep the in-app alert queued for next activation.
        if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) {
            [self showSystemNotification:title body:message id:[NSString stringWithFormat:@"assignment_%@", assignmentId ?: @"unknown"]];
        }

        UIAlertController *alert = [UIAlertController alertControllerWithTitle:title message:message preferredStyle:UIAlertControllerStyleAlert];
        if (ids.count > 0 && !incompleteGroup && canPickRequest) {
            NSString *actionTitle = isGroup ? @"✂️ Pick lẻ tất cả đơn trong chùm" : @"✅ Pick lẻ 1 đơn";
            [alert addAction:[UIAlertAction actionWithTitle:actionTitle style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
                if (handler) handler(isGroup ? @"split" : @"single", assignmentId ?: @"");
            }]];
        }
        [alert addAction:[UIAlertAction actionWithTitle:@"Bỏ qua" style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) {
            if (handler) handler(@"skip", assignmentId ?: @"");
        }]];
        [self presentSheet:alert];
    });
}

+ (void)showTestResult:(NSDictionary *)result {
    NSString *title = [result[@"title"] isKindOfClass:[NSString class]] ? result[@"title"] : @"🧪 Test API";
    NSString *message = [result[@"message"] isKindOfClass:[NSString class]] ? result[@"message"] : @"Đã chạy kiểm tra.";
    NSString *endpoint = [result[@"endpoint"] isKindOfClass:[NSString class]] ? result[@"endpoint"] : @"(chưa có)";
    NSString *method = [result[@"method"] isKindOfClass:[NSString class]] ? result[@"method"] : @"POST";
    NSString *payload = @"";
    id body = result[@"payload"];
    if ([NSJSONSerialization isValidJSONObject:body]) {
        NSData *data = [NSJSONSerialization dataWithJSONObject:body options:NSJSONWritingPrettyPrinted error:nil];
        if (data) payload = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
    }
    BOOL live = [result[@"liveTest"] boolValue];
    BOOL sent = [result[@"networkSent"] boolValue];
    NSString *status = live
        ? (sent ? @"\n\n✅ Request đã được chuyển tới RCTNetworking. Đây chưa phải xác nhận server chấp nhận; hãy kiểm tra kết quả PICK THÀNH CÔNG/THẤT BẠI." : @"\n\n⛔ Không gửi request thật.")
        : @"\n\n🧪 Kiểm tra nội bộ; không gửi request tới máy chủ.";
    NSString *responseRaw = [result[@"responseRaw"] isKindOfClass:[NSString class]] ? result[@"responseRaw"] : @"";
    if (responseRaw.length > 6000) responseRaw = [[responseRaw substringToIndex:6000] stringByAppendingString:@"… (đã cắt để tránh alert quá dài)"];
    NSNumber *httpStatus = [result[@"httpStatus"] isKindOfClass:[NSNumber class]] ? result[@"httpStatus"] : nil;
    NSString *responseSection = responseRaw.length ? [NSString stringWithFormat:@"\n\nHTTP status: %@\nResponse server:\n%@", httpStatus ? httpStatus : @"không đọc được", responseRaw] : @"";
    NSString *full = [NSString stringWithFormat:@"%@\n\nMethod: %@\nEndpoint: %@\nPayload: %@%@%@", message, method, endpoint, payload.length ? payload : @"(không có)", status, responseSection];
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:title message:full preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Đóng" style:UIAlertActionStyleDefault handler:nil]];
    [self presentSheet:alert];
}

+ (void)showLiveApiTestConfirmation:(NSDictionary *)preview decisionHandler:(void (^)(BOOL, NSString *, NSString *))handler {
    if (![preview isKindOfClass:[NSDictionary class]]) return;
    NSString *kind = [preview[@"kind"] isKindOfClass:[NSString class]] ? preview[@"kind"] : @"free_pick";
    NSString *token = [preview[@"token"] isKindOfClass:[NSString class]] ? preview[@"token"] : @"";
    NSString *title = [preview[@"title"] isKindOfClass:[NSString class]] ? preview[@"title"] : @"⚠️ Xác nhận request thật";
    NSString *message = [preview[@"message"] isKindOfClass:[NSString class]] ? preview[@"message"] : @"Request này có thể nhận đơn thật nếu máy chủ chấp nhận.";
    NSString *endpoint = [preview[@"endpoint"] isKindOfClass:[NSString class]] ? preview[@"endpoint"] : @"(không rõ)";
    id body = preview[@"payload"];
    NSData *data = [NSJSONSerialization isValidJSONObject:body] ? [NSJSONSerialization dataWithJSONObject:body options:NSJSONWritingPrettyPrinted error:nil] : nil;
    NSString *payload = data ? ([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"") : @"(không có)";
    NSString *full = [NSString stringWithFormat:@"%@\n\nEndpoint: %@\nPayload: %@\n\n⚠️ Request thật sẽ gửi ID giả tới máy chủ production. Thông thường server sẽ từ chối ID không tồn tại, nhưng app không thể bảo đảm backend luôn từ chối hoặc ID không thể trùng dữ liệu hợp lệ. Chỉ chạy trên tài khoản/môi trường bạn được phép kiểm thử. Không có nút hoàn tác ở phía AutoPick.", message, endpoint, payload];
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:title message:full preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Hủy, không gửi" style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) { if (handler) handler(NO, kind, token); }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Tôi hiểu, gửi request thật" style:UIAlertActionStyleDestructive handler:^(UIAlertAction *a) { if (handler) handler(YES, kind, token); }]];
    [self presentSheet:alert];
}

+ (void)notifyMatchDetail:(NSDictionary *)order {
    [[APFLogManager sharedManager] logInfo:@"NOTIFY.MATCH.REQUESTED" message:@"Đã yêu cầu thông báo đơn khớp" source:@"NOTIFY" context:nil];
    APFPrefs *p = [APFPrefs shared];
    if (!p.notifyOnMatch && !p.systemNotify) return;
    @try {
        NSInteger earn = [order[@"total_earnings_amount"] integerValue];
        NSInteger dist = [order[@"delivery_distance"] integerValue];
        NSArray *dos = order[@"delivery_orders"];
        NSInteger count = dos.count;
        if (count == 0) return;
        NSString *groupCode = order[@"pre_group_code"];
        BOOL isGroup = (groupCode != nil && count > 1);
        NSInteger totalCOD = 0;
        NSArray *innerOrders = order[@"orders"];
        if ([innerOrders isKindOfClass:[NSArray class]])
            for (NSDictionary *io in innerOrders) totalCOD += [io[@"cod_amount"] integerValue];
        NSString *pickupShop = @"?", *pickupAddr = @"?";
        NSDictionary *first = dos[0];
        NSDictionary *pu = first[@"pickup_address_info"];
        if ([pu isKindOfClass:[NSDictionary class]]) {
            pickupShop = pu[@"contact_name"] ?: @"?";
            pickupAddr = pu[@"address"] ?: @"?";
        }
        NSString *dropoffAddr = @"?";
        NSDictionary *do_ = dos[count-1][@"dropoff_address_info"];
        if ([do_ isKindOfClass:[NSDictionary class]]) dropoffAddr = do_[@"address"] ?: @"?";
        NSString *(^shorten)(NSString *, NSInteger) = ^(NSString *s, NSInteger max) {
            if (!s || s.length <= max) return s ?: @"?";
            return [NSString stringWithFormat:@"%@...", [s substringToIndex:max - 3]];
        };
        NSString *title = isGroup ? [NSString stringWithFormat:@"🎯 CHÙM %ld ĐƠN KHỚP!", (long)count] : @"🎯 ĐƠN KHỚP!";
        NSMutableString *body = [NSMutableString string];
        if (isGroup) [body appendFormat:@"📦 %ld đơn  |  💰 %@  |  📏 %.1fkm",
            (long)count, fmtPrice(earn), (double)dist/1000.0];
        else [body appendFormat:@"💰 %@  |  📏 %.1fkm", fmtPrice(earn), (double)dist/1000.0];
        if (totalCOD > 0) [body appendFormat:@"  |  💵 COD %@", fmtPrice(totalCOD)];
        [body appendFormat:@"\n📍 %@", shorten(pickupShop, 30)];
        [body appendFormat:@"\n%@", shorten(pickupAddr, 55)];
        [body appendFormat:@"\n🏁 %@", shorten(dropoffAddr, 55)];
        NSString *orderId = groupCode ? groupCode : [NSString stringWithFormat:@"%ld", (long)[dos[0][@"delivery_order_id"] integerValue]];
        if (p.soundOnMatch) AudioServicesPlaySystemSound(1057);
        if (p.vibrateOnMatch) AudioServicesPlaySystemSound(kSystemSoundID_Vibrate);
        if (p.systemNotify) [self showSystemNotification:title body:body
            id:[NSString stringWithFormat:@"m_%@_%ld", orderId, (long)[[NSDate date] timeIntervalSince1970]]];
        UIApplicationState state = [UIApplication sharedApplication].applicationState;
        if (state == UIApplicationStateActive && p.notifyOnMatch) {
            // Match details use a non-modal toast. Repeated order events must not block
            // touch input or stack transient UIAlertControllers over the settings menu.
            [self toast:[NSString stringWithFormat:@"%@\n%@", title, body]];
        }
    } @catch(NSException *e) {}
}

 + (void)showBatchPickSummary:(NSDictionary *)summary {
    if (![summary isKindOfClass:NSDictionary.class]) return;
    APFPrefs *prefs = [APFPrefs shared];
    NSInteger total = [summary[@"totalCount"] integerValue];
    NSInteger success = [summary[@"successCount"] integerValue];
    NSInteger failed = [summary[@"failureCount"] integerValue];
    NSInteger unknown = [summary[@"unknownCount"] integerValue];
    NSInteger notSent = [summary[@"notSentCount"] integerValue];
    BOOL allSuccess = total > 0 && success == total && failed == 0 && unknown == 0 && notSent == 0;
    BOOL forceNotify = [summary[@"forceNotify"] boolValue];
    NSString *assignmentId = [summary[@"assignmentId"] isKindOfClass:NSString.class] ? summary[@"assignmentId"] : @"";

    NSString *title = allSuccess
        ? [NSString stringWithFormat:@"✅ PICK LẺ ALL · %ld/%ld THÀNH CÔNG", (long)success, (long)total]
        : (failed > 0 && unknown == 0 && notSent == 0 && success == 0
            ? [NSString stringWithFormat:@"❌ PICK LẺ ALL · 0/%ld THÀNH CÔNG", (long)total]
            : [NSString stringWithFormat:@"⚠️ PICK LẺ ALL · %ld/%ld THÀNH CÔNG", (long)success, (long)total]);
    NSString *counts = (unknown == 0 && notSent == 0)
        ? [NSString stringWithFormat:@"📦 %ld đơn  |  ✅ %ld  ❌ %ld", (long)total, (long)success, (long)failed]
        : [NSString stringWithFormat:@"📦 %ld đơn  |  ✅ %ld  ❌ %ld  ⚠️ %ld  ⏭ %ld",
            (long)total, (long)success, (long)failed, (long)unknown, (long)notSent];

    NSMutableOrderedSet<NSString *> *serverFailureReasons = [NSMutableOrderedSet orderedSet];
    NSMutableOrderedSet<NSString *> *serverSuccessReasons = [NSMutableOrderedSet orderedSet];
    NSArray *responseDetails = [summary[@"responseDetails"] isKindOfClass:NSArray.class] ? summary[@"responseDetails"] : @[];
    for (id raw in responseDetails) {
        if (![raw isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *entry = raw;
        BOOL isFailure = [entry[@"outcome"] isEqualToString:@"FAILED"];
        NSString *msg = [entry[@"msg"] isKindOfClass:NSString.class] ? entry[@"msg"] : @"";
        NSNumber *code = [entry[@"code"] respondsToSelector:@selector(integerValue)] ? entry[@"code"] : nil;
        if (msg.length == 0) msg = isFailure ? @"Không rõ lý do" : @"success";
        NSString *line = code ? [NSString stringWithFormat:@"%@ (code %@)", msg, code] : msg;
        if (line.length > 100) line = [[line substringToIndex:97] stringByAppendingString:@"…"];
        NSMutableOrderedSet *target = isFailure ? serverFailureReasons : serverSuccessReasons;
        if (target.count < 2) [target addObject:line];
    }

    NSString *reason = nil;
    if (serverFailureReasons.count > 0) {
        reason = [NSString stringWithFormat:@"Server: %@", [[serverFailureReasons array] componentsJoinedByString:@"; "]];
    } else {
        NSArray *failureReasons = [summary[@"failureReasons"] isKindOfClass:NSArray.class] ? summary[@"failureReasons"] : @[];
        NSMutableOrderedSet<NSString *> *localReasons = [NSMutableOrderedSet orderedSet];
        for (id rawReason in failureReasons) {
            if (![rawReason isKindOfClass:NSString.class] || [rawReason length] == 0) continue;
            NSString *line = rawReason;
            if (line.length > 120) line = [[line substringToIndex:117] stringByAppendingString:@"…"];
            [localReasons addObject:line];
            if (localReasons.count >= 2) break;
        }
        if (localReasons.count > 0) reason = [[localReasons array] componentsJoinedByString:@"; "];
        else if (serverSuccessReasons.count > 0) reason = [NSString stringWithFormat:@"Server: %@", [[serverSuccessReasons array] componentsJoinedByString:@"; "]];
    }
    if (!reason && unknown > 0) {
        reason = @"Có response chưa đủ thông tin; cần đối chiếu trên app tài xế.";
    } else if (!reason && notSent > 0) {
        reason = @"Một số request chưa được chuyển tới networking.";
    } else if (!reason && failed > 0) {
        reason = @"Server từ chối một hoặc nhiều request Pick.";
    } else if (!reason) {
        reason = @"Server xác nhận code 0 cho toàn bộ request.";
    }
    NSString *body = [NSString stringWithFormat:@"%@\n%@", counts, reason];

    NSMutableArray *itemResults = [NSMutableArray array];
    NSArray *items = [summary[@"items"] isKindOfClass:NSArray.class] ? summary[@"items"] : @[];
    for (NSDictionary *item in items) {
        if (![item isKindOfClass:NSDictionary.class]) continue;
        [itemResults addObject:@{@"order_id": item[@"orderId"] ?: @0,
                                 @"status": item[@"status"] ?: @"UNKNOWN",
                                 @"detail": item[@"detail"] ?: @""}];
    }
    [[APFLogManager sharedManager] logWithLevel:(allSuccess ? APFLogLevelSuccess : APFLogLevelWarning)
        code:@"PICK.BATCH.NOTIFICATION" message:@"Đã tạo thông báo tổng kết batch PICK" source:@"NOTIFY"
        correlationID:[summary[@"batchId"] isKindOfClass:NSString.class] ? summary[@"batchId"] : nil
        context:@{@"total":@(total), @"success":@(success), @"failed":@(failed), @"unknown":@(unknown),
                  @"not_sent":@(notSent), @"assignment_id":assignmentId ?: @"",
                  @"force_notify":@(forceNotify), @"response_details":responseDetails ?: @[], @"items":itemResults}];

    if (assignmentId.length) {
        NSString *status = allSuccess ? @"PICKED" : (unknown > 0 || notSent > 0 ? @"UNKNOWN" : (success > 0 ? @"PARTIAL" : @"FAILED"));
        [self updateAssignmentHistory:assignmentId status:status detail:body];
    }
    if (allSuccess) {
        if (prefs.soundOnMatch) AudioServicesPlaySystemSound(1007);
    } else {
        AudioServicesPlaySystemSound(1053);
    }
    if (prefs.vibrateOnMatch) AudioServicesPlaySystemSound(kSystemSoundID_Vibrate);
    if (forceNotify || prefs.systemNotify) {
        [self showSystemNotification:title body:body
            id:[NSString stringWithFormat:@"batch_%@", summary[@"batchId"] ?: NSUUID.UUID.UUIDString]];
    }
    if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive &&
        (forceNotify || prefs.notifyOnSuccess || prefs.notifyOnMatch)) {
        [self toast:[NSString stringWithFormat:@"%@\n%@", title, body]];
    }
}

+ (void)showPickResult:(NSDictionary *)result success:(BOOL)success {
    if (![result isKindOfClass:NSDictionary.class]) return;
    BOOL forceNotify = [result[@"forceNotify"] boolValue];
    NSString *info = [result[@"info"] isKindOfClass:NSString.class] ? result[@"info"] : @"Đơn hàng";
    NSString *message = [result[@"responseMessage"] isKindOfClass:NSString.class] ? result[@"responseMessage"] :
        ([result[@"reason"] isKindOfClass:NSString.class] ? result[@"reason"] : (success ? @"success" : @"Không rõ lý do"));
    NSNumber *code = [result[@"responseCode"] respondsToSelector:@selector(integerValue)] ? result[@"responseCode"] : nil;
    NSString *title = success ? @"✅ PICK THÀNH CÔNG" : @"❌ PICK THẤT BẠI";
    NSString *reasonPrefix = code ? @"Server: " : @"Lý do: ";
    NSString *body = [NSString stringWithFormat:@"%@\n%@%@%@", info, reasonPrefix, message, code ? [NSString stringWithFormat:@" (code %@)", code] : @""];
    NSString *assignmentId = [result[@"assignmentId"] isKindOfClass:NSString.class] ? result[@"assignmentId"] : @"";
    if (assignmentId.length) [self updateAssignmentHistory:assignmentId status:(success ? @"PICKED" : @"FAILED") detail:body];
    [[APFLogManager sharedManager] logWithLevel:(success ? APFLogLevelSuccess : APFLogLevelError)
        code:(success ? @"NOTIFY.PICK_SUCCESS.FORCED" : @"NOTIFY.PICK_FAILED.FORCED")
        message:body source:@"NOTIFY"
        correlationID:(assignmentId.length ? assignmentId : nil)
        context:@{@"assignment_id":assignmentId ?: @"", @"response_code":code ?: @"", @"force_notify":@(forceNotify)}];
    if (forceNotify || [APFPrefs shared].systemNotify) [self showSystemNotification:title body:body id:[NSString stringWithFormat:@"assignment_pick_%@", NSUUID.UUID.UUIDString]];
    if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive && (forceNotify || [APFPrefs shared].notifyOnSuccess || [APFPrefs shared].notifyOnMatch)) {
        [self toast:[NSString stringWithFormat:@"%@\n%@", title, body]];
    }
    if (success && [APFPrefs shared].soundOnMatch) AudioServicesPlaySystemSound(1007);
    if (!success) AudioServicesPlaySystemSound(1053);
    if ([APFPrefs shared].vibrateOnMatch) AudioServicesPlaySystemSound(kSystemSoundID_Vibrate);
}

+ (void)notifySuccessDetail:(NSString *)orderInfo price:(NSInteger)price {
    [[APFLogManager sharedManager] logSuccess:@"NOTIFY.PICK_SUCCESS.REQUESTED" message:@"Đã yêu cầu thông báo PICK thành công" source:@"NOTIFY" context:nil];
    APFPrefs *p = [APFPrefs shared];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (p.soundOnMatch) AudioServicesPlaySystemSound(1007);
        if (p.vibrateOnMatch) AudioServicesPlaySystemSound(kSystemSoundID_Vibrate);
        NSString *title = @"✅ PICK THÀNH CÔNG";
        NSString *body = price > 0 ? [NSString stringWithFormat:@"%@\n💰 Tổng nhận: %@",
            orderInfo, fmtPrice(price)] : orderInfo;
        if (p.systemNotify) [self showSystemNotification:title body:body
            id:[NSString stringWithFormat:@"s_%ld", (long)[[NSDate date] timeIntervalSince1970]]];
        UIApplicationState state = [UIApplication sharedApplication].applicationState;
        if (state == UIApplicationStateActive && p.notifyOnSuccess) {
            [self toast:[NSString stringWithFormat:@"%@\n%@", title, body]];
        }
    });
}

+ (void)notifyPickFailed:(NSString *)reason {
    [[APFLogManager sharedManager] logInfo:@"NOTIFY.PICK_FAILED.REQUESTED" message:@"Đã yêu cầu thông báo PICK thất bại" source:@"NOTIFY" context:nil];
    APFPrefs *p = [APFPrefs shared];
    dispatch_async(dispatch_get_main_queue(), ^{
        AudioServicesPlaySystemSound(1053);
        if (p.vibrateOnMatch) AudioServicesPlaySystemSound(kSystemSoundID_Vibrate);
        NSString *title = @"❌ PICK THẤT BẠI";
        NSString *body = reason ?: @"Không rõ lý do";
        if (p.systemNotify) [self showSystemNotification:title body:body
            id:[NSString stringWithFormat:@"fail_%ld", (long)[[NSDate date] timeIntervalSince1970]]];
        UIApplicationState state = [UIApplication sharedApplication].applicationState;
        if (state == UIApplicationStateActive && p.notifyOnMatch) {
            [self toast:[NSString stringWithFormat:@"%@\n%@", title, body]];
        }
    });
}

@end
