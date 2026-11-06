#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>

#import <UserNotifications/UserNotifications.h>

@interface AppDelegate : UIResponder <UIApplicationDelegate, UNUserNotificationCenterDelegate>
@property (strong, nonatomic) UIWindow *window;
@property (strong, nonatomic) AVAudioPlayer *silentPlayer;
@property (nonatomic, assign) UIBackgroundTaskIdentifier bgTask;
@end
