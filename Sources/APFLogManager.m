#import "APFLogManager.h"
#import "APFPrefs.h"

NSNotificationName const APFLogManagerDidAppendEventNotification = @"APFLogManagerDidAppendEventNotification";
NSString * const APFLogManagerEventUserInfoKey = @"event";

static NSUInteger const kAPFLogMaxFileBytes = 2 * 1024 * 1024;
static NSUInteger const kAPFLogMaxArchives = 4; // plus current.jsonl = five files total
static NSUInteger const kAPFLogMaxPendingEvents = 5000;
static NSUInteger const kAPFLogBatchSize = 50;
static NSUInteger const kAPFLogMemoryFallbackLimit = 256;

@interface APFLogManager ()
@property (nonatomic, copy, readwrite) NSString *logDirectoryPath;
@property (nonatomic) dispatch_queue_t ioQueue;
@property (nonatomic) NSMutableArray<NSDictionary *> *pendingEvents;
@property (nonatomic) NSMutableArray<NSDictionary *> *memoryFallbackEvents;
@property (nonatomic) BOOL flushScheduled;
@property (nonatomic) NSUInteger droppedEventCount;
@end

@implementation APFLogManager

+ (instancetype)sharedManager {
    static APFLogManager *manager;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        manager = [[APFLogManager alloc] initPrivate];
    });
    return manager;
}

- (instancetype)init {
    return [APFLogManager sharedManager];
}

- (instancetype)initPrivate {
    self = [super init];
    if (!self) return nil;

    _ioQueue = dispatch_queue_create("com.autopick.logging.io", DISPATCH_QUEUE_SERIAL);
    _pendingEvents = [NSMutableArray array];
    _memoryFallbackEvents = [NSMutableArray array];

    NSURL *baseURL = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                            inDomains:NSUserDomainMask].firstObject;
    NSURL *directoryURL = [baseURL URLByAppendingPathComponent:@"AutoPick/Logs" isDirectory:YES];
    _logDirectoryPath = directoryURL.path;

    dispatch_sync(_ioQueue, ^{
        NSError *error = nil;
        [[NSFileManager defaultManager] createDirectoryAtURL:directoryURL
                                 withIntermediateDirectories:YES
                                                  attributes:nil
                                                       error:&error];
        if (error) {
            NSLog(@"[APFLogManager] LOG.INIT_FAILED: %@", error.localizedDescription);
        } else {
            [self applyFileProtectionAndBackupExclusionToURL:directoryURL];
        }
    });
    return self;
}

#pragma mark - Public logging API

- (void)logInfo:(NSString *)code message:(NSString *)message source:(NSString *)source context:(NSDictionary *)context {
    [self logWithLevel:APFLogLevelInfo code:code message:message source:source correlationID:nil context:context];
}

- (void)logSuccess:(NSString *)code message:(NSString *)message source:(NSString *)source context:(NSDictionary *)context {
    [self logWithLevel:APFLogLevelSuccess code:code message:message source:source correlationID:nil context:context];
}

- (void)logWarning:(NSString *)code message:(NSString *)message source:(NSString *)source context:(NSDictionary *)context {
    [self logWithLevel:APFLogLevelWarning code:code message:message source:source correlationID:nil context:context];
}

- (void)logError:(NSString *)code message:(NSString *)message source:(NSString *)source context:(NSDictionary *)context {
    [self logWithLevel:APFLogLevelError code:code message:message source:source correlationID:nil context:context];
}

- (void)logWithLevel:(APFLogLevel)level
                code:(NSString *)code
             message:(NSString *)message
              source:(NSString *)source
       correlationID:(NSString *)correlationID
             context:(NSDictionary<NSString *,id> *)context {
    if (level == APFLogLevelInfo && ![APFPrefs shared].loggingEnabled) return;
    NSString *safeCode = ([code isKindOfClass:NSString.class] && code.length) ? code : @"LOG.UNSPECIFIED";
    NSString *safeMessage = ([message isKindOfClass:NSString.class] && message.length) ? message : @"(empty message)";
    NSString *safeSource = ([source isKindOfClass:NSString.class] && source.length) ? source : @"APP";

    NSDictionary *safeContext = [self sanitizedContext:context ?: @{}];
    NSDictionary *event = @{
        @"version": @1,
        @"event_id": NSUUID.UUID.UUIDString.lowercaseString,
        @"timestamp": [self utcTimestamp],
        @"level": [self stringForLevel:level],
        @"code": safeCode,
        @"source": safeSource,
        @"message": safeMessage,
        @"context": safeContext,
        @"correlation_id": (correlationID.length ? correlationID : NSNull.null)
    };

    dispatch_async(self.ioQueue, ^{
        if (self.pendingEvents.count >= kAPFLogMaxPendingEvents) {
            // Prefer preserving recent diagnostics. Dropped events are counted and
            // reported in the next persisted batch instead of recursively logging.
            [self.pendingEvents removeObjectAtIndex:0];
            self.droppedEventCount += 1;
        }
        [self.pendingEvents addObject:event];
        [self postEventOnMainQueue:event];

        // Persist result/error transitions immediately; INFO is batched to reduce I/O
        // on high-frequency refresh/filter paths.
        if (level == APFLogLevelWarning || level == APFLogLevelError || level == APFLogLevelSuccess || self.pendingEvents.count >= kAPFLogBatchSize) {
            [self drainPendingEventsOnQueue:YES];
        } else {
            [self scheduleFlushOnQueue];
        }
    });
}

- (BOOL)handleAgentMessage:(NSDictionary *)message {
    if (![message isKindOfClass:NSDictionary.class]) return NO;
    if (![message[@"type"] isEqual:@"log_event"]) return NO;

    NSDictionary *event = message[@"event"];
    if (![event isKindOfClass:NSDictionary.class]) return NO;

    NSString *levelString = [event[@"level"] isKindOfClass:NSString.class] ? [event[@"level"] uppercaseString] : @"INFO";
    APFLogLevel level = APFLogLevelInfo;
    if ([levelString isEqualToString:@"SUCCESS"]) level = APFLogLevelSuccess;
    else if ([levelString isEqualToString:@"WARNING"]) level = APFLogLevelWarning;
    else if ([levelString isEqualToString:@"ERROR"]) level = APFLogLevelError;

    NSString *code = [event[@"code"] isKindOfClass:NSString.class] ? event[@"code"] : @"FRIDA.EVENT_UNSPECIFIED";
    NSString *messageText = [event[@"message"] isKindOfClass:NSString.class] ? event[@"message"] : @"Agent event";
    NSString *source = [event[@"source"] isKindOfClass:NSString.class] ? event[@"source"] : @"FRIDA";
    NSString *correlationID = [event[@"correlation_id"] isKindOfClass:NSString.class] ? event[@"correlation_id"] : nil;
    NSDictionary *context = [event[@"context"] isKindOfClass:NSDictionary.class] ? event[@"context"] : @{};

    [self logWithLevel:level code:code message:messageText source:source correlationID:correlationID context:context];
    return YES;
}

- (void)flush {
    dispatch_async(self.ioQueue, ^{
        [self drainPendingEventsOnQueue:YES];
    });
}

#pragma mark - Queue and persistence

- (void)scheduleFlushOnQueue {
    if (self.flushScheduled) return;
    self.flushScheduled = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), self.ioQueue, ^{
        self.flushScheduled = NO;
        [self drainPendingEventsOnQueue:NO];
    });
}

- (void)drainPendingEventsOnQueue:(BOOL)synchronize {
    if (self.pendingEvents.count == 0 && self.memoryFallbackEvents.count == 0) return;

    NSMutableArray<NSDictionary *> *batch = [NSMutableArray arrayWithCapacity:self.memoryFallbackEvents.count + self.pendingEvents.count];
    [batch addObjectsFromArray:self.memoryFallbackEvents];
    [batch addObjectsFromArray:self.pendingEvents];
    [self.memoryFallbackEvents removeAllObjects];
    [self.pendingEvents removeAllObjects];

    if (self.droppedEventCount > 0) {
        NSDictionary *dropEvent = @{
            @"version": @1,
            @"event_id": NSUUID.UUID.UUIDString.lowercaseString,
            @"timestamp": [self utcTimestamp],
            @"level": @"WARNING",
            @"code": @"LOG.EVENTS_DROPPED",
            @"source": @"LOGGER",
            @"message": @"Logger queue reached its limit; older queued events were discarded",
            @"context": @{@"dropped_count": @(self.droppedEventCount)},
            @"correlation_id": NSNull.null
        };
        [batch addObject:dropEvent];
        self.droppedEventCount = 0;
    }

    NSError *error = nil;
    if (![self appendEvents:batch synchronize:synchronize error:&error]) {
        NSLog(@"[APFLogManager] LOG.WRITE_FAILED: %@", error.localizedDescription ?: @"unknown error");
        for (NSDictionary *event in batch) {
            if (self.memoryFallbackEvents.count >= kAPFLogMemoryFallbackLimit) {
                [self.memoryFallbackEvents removeObjectAtIndex:0];
            }
            [self.memoryFallbackEvents addObject:event];
        }
    }
}

- (BOOL)appendEvents:(NSArray<NSDictionary *> *)events synchronize:(BOOL)synchronize error:(NSError **)outError {
    if (events.count == 0) return YES;

    NSMutableData *data = [NSMutableData data];
    for (NSDictionary *event in events) {
        NSError *jsonError = nil;
        NSData *line = [NSJSONSerialization dataWithJSONObject:event options:NSJSONWritingFragmentsAllowed error:&jsonError];
        if (!line) {
            if (outError) *outError = jsonError ?: [self loggerError:100 description:@"Unable to serialize log event"];
            return NO;
        }
        [data appendData:line];
        [data appendBytes:"\n" length:1];
    }

    NSURL *currentURL = [NSURL fileURLWithPath:[self.logDirectoryPath stringByAppendingPathComponent:@"current.jsonl"]];
    if (![self rotateIfNeededForIncomingBytes:data.length currentURL:currentURL error:outError]) return NO;

    NSFileManager *fm = NSFileManager.defaultManager;
    if (![fm fileExistsAtPath:currentURL.path]) {
        if (![fm createFileAtPath:currentURL.path contents:nil attributes:@{NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication}]) {
            if (outError) *outError = [self loggerError:101 description:@"Unable to create current.jsonl"];
            return NO;
        }
        [self applyFileProtectionAndBackupExclusionToURL:currentURL];
    }

    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:currentURL.path];
    if (!handle) {
        if (outError) *outError = [self loggerError:102 description:@"Unable to open current.jsonl"];
        return NO;
    }

    @try {
        [handle seekToEndOfFile];
        [handle writeData:data];
        if (synchronize) [handle synchronizeFile];
        [handle closeFile];
    } @catch (NSException *exception) {
        @try { [handle closeFile]; } @catch (__unused NSException *closeException) {}
        if (outError) *outError = [self loggerError:103 description:exception.reason ?: @"File write exception"];
        return NO;
    }
    return YES;
}

- (BOOL)rotateIfNeededForIncomingBytes:(NSUInteger)incomingBytes currentURL:(NSURL *)currentURL error:(NSError **)outError {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSDictionary *attributes = [fm attributesOfItemAtPath:currentURL.path error:nil];
    unsigned long long currentSize = [attributes[NSFileSize] unsignedLongLongValue];
    if (currentSize == 0 || currentSize + incomingBytes <= kAPFLogMaxFileBytes) return YES;

    NSString *stamp = [self archiveTimestamp];
    NSString *archiveName = [NSString stringWithFormat:@"archive-%@-%@.jsonl", stamp, NSUUID.UUID.UUIDString.lowercaseString];
    NSURL *archiveURL = [NSURL fileURLWithPath:[self.logDirectoryPath stringByAppendingPathComponent:archiveName]];
    NSError *moveError = nil;
    if (![fm moveItemAtURL:currentURL toURL:archiveURL error:&moveError]) {
        if (outError) *outError = moveError ?: [self loggerError:104 description:@"Unable to rotate current log"];
        return NO;
    }
    [self applyFileProtectionAndBackupExclusionToURL:archiveURL];

    NSArray<NSURL *> *archives = [self archiveURLsOldestFirst];
    while (archives.count > kAPFLogMaxArchives) {
        NSURL *oldest = archives.firstObject;
        [fm removeItemAtURL:oldest error:nil];
        archives = [self archiveURLsOldestFirst];
    }
    return YES;
}

- (NSArray<NSURL *> *)archiveURLsOldestFirst {
    NSURL *directoryURL = [NSURL fileURLWithPath:self.logDirectoryPath isDirectory:YES];
    NSArray<NSURL *> *urls = [[NSFileManager defaultManager] contentsOfDirectoryAtURL:directoryURL
                                                          includingPropertiesForKeys:@[NSURLContentModificationDateKey]
                                                                             options:NSDirectoryEnumerationSkipsHiddenFiles
                                                                               error:nil] ?: @[];
    NSMutableArray<NSURL *> *archives = [NSMutableArray array];
    for (NSURL *url in urls) {
        if ([url.lastPathComponent hasPrefix:@"archive-"] && [url.pathExtension isEqualToString:@"jsonl"]) {
            [archives addObject:url];
        }
    }
    [archives sortUsingComparator:^NSComparisonResult(NSURL *a, NSURL *b) {
        NSDate *dateA = nil, *dateB = nil;
        [a getResourceValue:&dateA forKey:NSURLContentModificationDateKey error:nil];
        [b getResourceValue:&dateB forKey:NSURLContentModificationDateKey error:nil];
        return [dateA compare:dateB];
    }];
    return archives;
}

#pragma mark - Export and maintenance

- (void)loadRecentEventsWithLimit:(NSUInteger)limit completion:(void (^)(NSArray<NSDictionary *> *))completion {
    if (!completion) return;
    NSUInteger safeLimit = MAX(1, MIN(limit, 5000));
    dispatch_async(self.ioQueue, ^{
        // Include queued events so the viewer does not miss the most recent entries.
        [self drainPendingEventsOnQueue:YES];
        NSMutableArray<NSURL *> *files = [NSMutableArray arrayWithArray:[self archiveURLsOldestFirst]];
        NSURL *currentURL = [NSURL fileURLWithPath:[self.logDirectoryPath stringByAppendingPathComponent:@"current.jsonl"]];
        if ([NSFileManager.defaultManager fileExistsAtPath:currentURL.path]) [files addObject:currentURL];

        NSMutableArray<NSDictionary *> *events = [NSMutableArray array];
        for (NSURL *url in files) {
            NSData *data = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:nil];
            if (!data.length) continue;
            NSString *contents = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            if (!contents.length) continue;
            [contents enumerateLinesUsingBlock:^(NSString *line, BOOL *stop) {
                if (!line.length) return;
                NSData *lineData = [line dataUsingEncoding:NSUTF8StringEncoding];
                id object = lineData ? [NSJSONSerialization JSONObjectWithData:lineData options:NSJSONReadingFragmentsAllowed error:nil] : nil;
                if ([object isKindOfClass:NSDictionary.class]) [events addObject:object];
            }];
        }
        // Keep the bounded in-memory fallback visible if the filesystem is temporarily unavailable.
        [events addObjectsFromArray:self.memoryFallbackEvents];
        [events sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
            NSString *ta = [a[@"timestamp"] isKindOfClass:NSString.class] ? a[@"timestamp"] : @"";
            NSString *tb = [b[@"timestamp"] isKindOfClass:NSString.class] ? b[@"timestamp"] : @"";
            return [tb compare:ta]; // newest first
        }];
        if (events.count > safeLimit) [events removeObjectsInRange:NSMakeRange(safeLimit, events.count - safeLimit)];
        NSArray<NSDictionary *> *result = [events copy];
        dispatch_async(dispatch_get_main_queue(), ^{ completion(result); });
    });
}

- (void)exportLogsWithCompletion:(void (^)(NSURL *, NSError *))completion {
    if (!completion) return;
    dispatch_async(self.ioQueue, ^{
        [self drainPendingEventsOnQueue:YES];
        NSMutableArray<NSURL *> *files = [NSMutableArray arrayWithArray:[self archiveURLsOldestFirst]];
        NSURL *currentURL = [NSURL fileURLWithPath:[self.logDirectoryPath stringByAppendingPathComponent:@"current.jsonl"]];
        if ([NSFileManager.defaultManager fileExistsAtPath:currentURL.path]) [files addObject:currentURL];

        NSMutableData *combined = [NSMutableData data];
        NSError *readError = nil;
        for (NSURL *url in files) {
            NSData *contents = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:&readError];
            if (!contents) break;
            [combined appendData:contents];
        }

        NSURL *outputURL = nil;
        if (!readError) {
            NSString *name = [NSString stringWithFormat:@"AutoPick-Logs-%@.jsonl", [self archiveTimestamp]];
            outputURL = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:name]];
            if (![combined writeToURL:outputURL options:NSDataWritingAtomic error:&readError]) outputURL = nil;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(outputURL, readError);
        });
    });
}

- (void)clearHistoryWithCompletion:(dispatch_block_t)completion {
    dispatch_async(self.ioQueue, ^{
        [self.pendingEvents removeAllObjects];
        [self.memoryFallbackEvents removeAllObjects];
        NSArray<NSURL *> *archives = [self archiveURLsOldestFirst];
        for (NSURL *url in archives) [NSFileManager.defaultManager removeItemAtURL:url error:nil];
        NSURL *currentURL = [NSURL fileURLWithPath:[self.logDirectoryPath stringByAppendingPathComponent:@"current.jsonl"]];
        [NSFileManager.defaultManager removeItemAtURL:currentURL error:nil];
        if (completion) dispatch_async(dispatch_get_main_queue(), completion);
    });
}

#pragma mark - Helpers

- (void)postEventOnMainQueue:(NSDictionary *)event {
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSNotificationCenter defaultCenter] postNotificationName:APFLogManagerDidAppendEventNotification
                                                            object:self
                                                          userInfo:@{APFLogManagerEventUserInfoKey: event}];
    });
}

- (NSString *)stringForLevel:(APFLogLevel)level {
    switch (level) {
        case APFLogLevelSuccess: return @"SUCCESS";
        case APFLogLevelWarning: return @"WARNING";
        case APFLogLevelError: return @"ERROR";
        case APFLogLevelInfo:
        default: return @"INFO";
    }
}

- (NSString *)utcTimestamp {
    static NSDateFormatter *formatter;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
        formatter.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";
    });
    @synchronized (formatter) {
        return [formatter stringFromDate:NSDate.date];
    }
}

- (NSString *)archiveTimestamp {
    static NSDateFormatter *formatter;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
        formatter.dateFormat = @"yyyyMMdd-HHmmss-SSS";
    });
    @synchronized (formatter) {
        return [formatter stringFromDate:NSDate.date];
    }
}

- (NSDictionary *)sanitizedContext:(NSDictionary *)context {
    if (![context isKindOfClass:NSDictionary.class]) return @{};
    return [self sanitizeObject:context];
}

- (id)sanitizeObject:(id)object {
    if ([object isKindOfClass:NSDictionary.class]) {
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        [(NSDictionary *)object enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
            NSString *keyString = [key isKindOfClass:NSString.class] ? key : [key description];
            NSString *lower = keyString.lowercaseString;
            NSArray<NSString *> *sensitive = @[@"authorization", @"token", @"cookie", @"password", @"secret", @"phone", @"address", @"customer", @"email", @"request_body", @"response_body"];
            BOOL redact = NO;
            for (NSString *needle in sensitive) {
                if ([lower containsString:needle]) { redact = YES; break; }
            }
            result[keyString] = redact ? @"[REDACTED]" : [self sanitizeObject:value] ?: NSNull.null;
        }];
        return result;
    }
    if ([object isKindOfClass:NSArray.class]) {
        NSMutableArray *result = [NSMutableArray array];
        for (id value in (NSArray *)object) [result addObject:[self sanitizeObject:value] ?: NSNull.null];
        return result;
    }
    if ([object isKindOfClass:NSString.class] || [object isKindOfClass:NSNumber.class] || object == NSNull.null) return object;
    if ([object isKindOfClass:NSDate.class]) return [self utcTimestamp];
    return [object description] ?: @"";
}

- (void)applyFileProtectionAndBackupExclusionToURL:(NSURL *)url {
    NSError *error = nil;
    [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error];
    if (error) NSLog(@"[APFLogManager] LOG.BACKUP_EXCLUSION_FAILED: %@", error.localizedDescription);
    [[NSFileManager defaultManager] setAttributes:@{NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication}
                                     ofItemAtPath:url.path
                                            error:nil];
}

- (NSError *)loggerError:(NSInteger)code description:(NSString *)description {
    return [NSError errorWithDomain:@"com.autopick.logging" code:code userInfo:@{NSLocalizedDescriptionKey: description ?: @"Logging error"}];
}

@end
