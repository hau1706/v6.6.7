#import <UIKit/UIKit.h>

@interface APFMenu : NSObject
+ (void)presentMenu;
+ (void)notifyMatchDetail:(NSDictionary *)order;
+ (void)notifySuccessDetail:(NSString *)orderInfo price:(NSInteger)price;
+ (void)notifyPickFailed:(NSString *)reason;
+ (void)showPickResult:(NSDictionary *)result success:(BOOL)success;
+ (void)saveSkippedAssignment:(NSDictionary *)assignment;
+ (void)updateAssignmentHistory:(NSString *)assignmentId status:(NSString *)status detail:(NSString *)detail;
+ (void)showSkippedAssignmentHistoryWithPickHandler:(void (^)(NSDictionary *assignment))handler;
+ (void)showBatchPickSummary:(NSDictionary *)summary;
+ (void)requestNotificationPermission;
+ (void)showSystemNotification:(NSString *)title body:(NSString *)body id:(NSString *)ident;
+ (void)setReloadJSCallback:(void (^)(void))cb;
+ (void)showTestResult:(NSDictionary *)result;
+ (void)showLiveApiTestConfirmation:(NSDictionary *)preview decisionHandler:(void (^)(BOOL confirmed, NSString *kind, NSString *token))handler;
+ (void)showAssignmentPrompt:(NSDictionary *)assignment decisionHandler:(void (^)(NSString *action, NSString *assignmentId))handler;
@end
