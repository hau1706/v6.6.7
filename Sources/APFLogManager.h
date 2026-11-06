#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSNotificationName const APFLogManagerDidAppendEventNotification;
FOUNDATION_EXPORT NSString * const APFLogManagerEventUserInfoKey;

typedef NS_ENUM(NSUInteger, APFLogLevel) {
    APFLogLevelInfo = 0,
    APFLogLevelSuccess,
    APFLogLevelWarning,
    APFLogLevelError
};

/// A single, asynchronous JSONL logging pipeline for app and Frida-agent events.
/// Calls are safe from background queues. Logging must never control business state.
@interface APFLogManager : NSObject

+ (instancetype)sharedManager;

@property (nonatomic, copy, readonly) NSString *logDirectoryPath;

- (void)logWithLevel:(APFLogLevel)level
                code:(NSString *)code
             message:(NSString *)message
              source:(NSString *)source
       correlationID:(nullable NSString *)correlationID
             context:(nullable NSDictionary<NSString *, id> *)context;

- (void)logInfo:(NSString *)code
        message:(NSString *)message
         source:(NSString *)source
        context:(nullable NSDictionary<NSString *, id> *)context;

- (void)logSuccess:(NSString *)code
           message:(NSString *)message
            source:(NSString *)source
           context:(nullable NSDictionary<NSString *, id> *)context;

- (void)logWarning:(NSString *)code
           message:(NSString *)message
            source:(NSString *)source
           context:(nullable NSDictionary<NSString *, id> *)context;

- (void)logError:(NSString *)code
         message:(NSString *)message
          source:(NSString *)source
         context:(nullable NSDictionary<NSString *, id> *)context;

/// Accepts the structured Frida message: { type: "log_event", event: { ... } }.
/// Returns NO for unsupported or malformed messages; this method does not throw.
- (BOOL)handleAgentMessage:(NSDictionary *)message;

/// Flushes queued events to disk asynchronously.
- (void)flush;

/// Loads the newest persisted JSONL events. Completion is called on the main queue.
- (void)loadRecentEventsWithLimit:(NSUInteger)limit
                       completion:(void (^)(NSArray<NSDictionary *> *events))completion;

/// Exports current + archived JSONL records into one temporary JSONL file.
- (void)exportLogsWithCompletion:(void (^)(NSURL * _Nullable url, NSError * _Nullable error))completion;

/// Removes current and archived logs. Completion is called on the main queue.
- (void)clearHistoryWithCompletion:(nullable dispatch_block_t)completion;

@end

NS_ASSUME_NONNULL_END
