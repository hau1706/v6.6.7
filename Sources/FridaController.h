#import <Foundation/Foundation.h>

typedef void (^FridaLogBlock)(NSArray<NSString *> *lines);
typedef void (^FridaNotifyBlock)(NSString *type, NSDictionary *payload);
typedef void (^FridaDetachBlock)(NSString *reason);

@interface FridaController : NSObject
+ (instancetype)shared;

@property (nonatomic, copy) FridaLogBlock logHandler;
@property (nonatomic, copy) FridaNotifyBlock notifyHandler;
@property (nonatomic, copy) FridaDetachBlock detachHandler;

// JS source control
- (NSString *)jsSource;
- (void)reloadJSFromRemote;
- (void)setJSRemoteURL:(NSString *)url;

- (BOOL)spawnAndAttach:(NSError **)error;
- (void)detach;
- (BOOL)isAttached;
- (BOOL)isFoodyRunning;
- (void)handleMessage:(NSString *)json;
- (void)handleDetach:(NSString *)reason;
- (void)handleDetach:(NSString *)reason sessionId:(uintptr_t)sid;   // bỏ qua nếu là session cũ

- (void)updatePrefs:(NSDictionary *)prefs;
- (void)start;
- (void)stop;
- (void)resolveAssignment:(NSString *)assignmentId action:(NSString *)action;
- (void)repickAssignment:(NSDictionary *)assignment;
- (void)previewLiveApiTest:(NSString *)kind;
- (void)confirmLiveApiTest:(NSString *)kind token:(NSString *)token;
@end
