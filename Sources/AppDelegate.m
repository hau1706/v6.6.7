#import "AppDelegate.h"
#import "TestViewController.h"
#import "APFLogManager.h"
#import <UserNotifications/UserNotifications.h>

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
        didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    TestViewController *vc = [[TestViewController alloc] init];
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.navigationBar.prefersLargeTitles = NO;
    self.window.rootViewController = nav;
    [self.window makeKeyAndVisible];

    [UNUserNotificationCenter currentNotificationCenter].delegate = self;

    [self setupBackgroundAudio];
    [self appLog:@"🚀 App launched"];
    self.bgTask = UIBackgroundTaskInvalid;

    return YES;
}

#pragma mark - UNUserNotificationCenterDelegate

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    NSLog(@"[AppDelegate] willPresentNotification: %@", notification.request.content.title);
    UNNotificationPresentationOptions opts =
        UNNotificationPresentationOptionBanner |
        UNNotificationPresentationOptionSound |
        UNNotificationPresentationOptionBadge;
    completionHandler(opts);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    NSLog(@"[AppDelegate] User tapped notification: %@", response.notification.request.content.title);
    completionHandler();
}

#pragma mark - App log

- (void)appLog:(NSString *)msg {
    [[APFLogManager sharedManager] logInfo:@"APP.LIFECYCLE" message:msg source:@"APP" context:nil];
    NSDateFormatter *df = [[NSDateFormatter alloc] init];
    df.dateFormat = @"HH:mm:ss";
    NSString *ts = [df stringFromDate:[NSDate date]];
    NSString *line = [NSString stringWithFormat:@"[%@] [App] %@\n", ts, msg];

    NSArray *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *path = [docs[0] stringByAppendingPathComponent:@"app_lifecycle.log"];
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:path]) [fm createFileAtPath:path contents:nil attributes:nil];
    NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:path];
    if (fh) {
        @try {
            [fh seekToEndOfFile];
            [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
        } @catch (NSException *e) {}
        [fh closeFile];
    }

    [[NSNotificationCenter defaultCenter] postNotificationName:@"LogUpdated" object:nil];
}

#pragma mark - Background audio

- (void)setupBackgroundAudio {
    NSError *err = nil;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    [session setCategory:AVAudioSessionCategoryPlayback
             withOptions:AVAudioSessionCategoryOptionMixWithOthers error:&err];
    [session setActive:YES error:&err];

    NSString *silentPath = [self generateSilentWav];
    if (!silentPath) return;
    NSURL *url = [NSURL fileURLWithPath:silentPath];
    self.silentPlayer = [[AVAudioPlayer alloc] initWithContentsOfURL:url error:&err];
    if (err) return;
    self.silentPlayer.numberOfLoops = -1;
    self.silentPlayer.volume = 0.0;
    [self.silentPlayer prepareToPlay];
    [self.silentPlayer play];
}

- (NSString *)generateSilentWav {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:@"silent.wav"];
    if ([[NSFileManager defaultManager] fileExistsAtPath:path]) return path;
    NSMutableData *wav = [NSMutableData data];
    [wav appendBytes:"RIFF" length:4];
    uint32_t chunkSize = 36 + 16000;   // FIX: phải khớp dataSize (16000), trước là 8000
    [wav appendBytes:&chunkSize length:4];
    [wav appendBytes:"WAVE" length:4];
    [wav appendBytes:"fmt " length:4];
    uint32_t fmtSize = 16;
    [wav appendBytes:&fmtSize length:4];
    uint16_t audioFormat = 1;
    [wav appendBytes:&audioFormat length:2];
    uint16_t numChannels = 1;
    [wav appendBytes:&numChannels length:2];
    uint32_t sampleRate = 8000;
    [wav appendBytes:&sampleRate length:4];
    uint32_t byteRate = 8000 * 2;
    [wav appendBytes:&byteRate length:4];
    uint16_t blockAlign = 2;
    [wav appendBytes:&blockAlign length:2];
    uint16_t bitsPerSample = 16;
    [wav appendBytes:&bitsPerSample length:2];
    [wav appendBytes:"data" length:4];
    uint32_t dataSize = 8000 * 2;
    [wav appendBytes:&dataSize length:4];
    uint8_t zeros[16000];
    memset(zeros, 0, sizeof(zeros));
    [wav appendBytes:zeros length:sizeof(zeros)];
    [wav writeToFile:path atomically:YES];
    return path;
}

#pragma mark - Lifecycle

- (void)applicationWillResignActive:(UIApplication *)application {
    [self appLog:@"⚠️ App resigning active"];
}
- (void)applicationDidEnterBackground:(UIApplication *)application {
    [[APFLogManager sharedManager] flush];
    [self appLog:@"⬇️ App vào BACKGROUND"];
    __weak typeof(self) ws = self;
    self.bgTask = [application beginBackgroundTaskWithExpirationHandler:^{
        [application endBackgroundTask:ws.bgTask];
        ws.bgTask = UIBackgroundTaskInvalid;
    }];
    if (self.silentPlayer && !self.silentPlayer.isPlaying) [self.silentPlayer play];
}
- (void)applicationWillEnterForeground:(UIApplication *)application {
    [self appLog:@"⬆️ App vào FOREGROUND"];
    if (self.bgTask != UIBackgroundTaskInvalid) {
        [application endBackgroundTask:self.bgTask];
        self.bgTask = UIBackgroundTaskInvalid;
    }
    if (self.silentPlayer && !self.silentPlayer.isPlaying) [self.silentPlayer play];
}
- (void)applicationDidBecomeActive:(UIApplication *)application {
    [self appLog:@"▶️ App became ACTIVE"];
    [[NSNotificationCenter defaultCenter] postNotificationName:@"AppBecameActive" object:nil];
}
- (void)applicationWillTerminate:(UIApplication *)application {
    [[APFLogManager sharedManager] flush];
    [self appLog:@"🛑 App WILL TERMINATE"];
}

@end
