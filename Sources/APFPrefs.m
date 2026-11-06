#import "APFPrefs.h"

@implementation APFPrefs

+ (instancetype)shared {
    static APFPrefs *inst = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        inst = [[APFPrefs alloc] init];
        [inst setDefaults];
        [inst load];
    });
    return inst;
}

- (NSString *)filePath {
    NSArray *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    return [docs[0] stringByAppendingPathComponent:@"autopick_prefs.plist"];
}

- (void)setDefaults {
    _enabled = YES;
    _autoRefresh = YES;
    _autoPick = YES;
    _stopAfterPick = NO;
    _systemNotify = YES;
    _notifyOnMatch = YES;
    _notifyOnSuccess = YES;
    _notifyOnAssignment = YES;
    _soundOnMatch = YES;
    _vibrateOnMatch = YES;
    _verboseLog = NO;
    _loggingEnabled = YES;
    _pickAllSinglesInGroup = NO;
    _pickAllSinglesInGroupMinDistance = 20000; // ⭐ Mặc định 20km
    _refreshIntervalMs = 300;
    _requestMaxDistance = 6000;
    _minPrice = 0;
    _maxPrice = 0;
    _minDistance = 0;
    _maxDistance = 50000;
    _minCOD = 0;
    _maxCOD = 0;
    _maxOrdersPerSession = 5;
    _cooldown = 0.5;
    _preferredCategories = @[@(6)];
    _preferredDistricts = @[];
    _districtFilterMode = 0;
    _blockedURL = @"";
    _orderDataUploadEnabled = NO;
    _orderDataUploadToken = @"";
}

- (void)load {
    NSString *path = [self filePath];
    NSDictionary *dict = [NSDictionary dictionaryWithContentsOfFile:path];
    if (!dict) return;

    id v;
    v = dict[@"enabled"]; if (v) _enabled = [v boolValue];
    v = dict[@"autoRefresh"]; if (v) _autoRefresh = [v boolValue];
    v = dict[@"autoPick"]; if (v) _autoPick = [v boolValue];
    v = dict[@"stopAfterPick"]; if (v) _stopAfterPick = [v boolValue];
    v = dict[@"systemNotify"]; if (v) _systemNotify = [v boolValue];
    v = dict[@"notifyOnMatch"]; if (v) _notifyOnMatch = [v boolValue];
    v = dict[@"notifyOnSuccess"]; if (v) _notifyOnSuccess = [v boolValue];
    v = dict[@"notifyOnAssignment"]; if (v) _notifyOnAssignment = [v boolValue];
    v = dict[@"soundOnMatch"]; if (v) _soundOnMatch = [v boolValue];
    v = dict[@"vibrateOnMatch"]; if (v) _vibrateOnMatch = [v boolValue];
    v = dict[@"verboseLog"]; if (v) _verboseLog = [v boolValue];
    v = dict[@"loggingEnabled"]; if (v) _loggingEnabled = [v boolValue];
    v = dict[@"pickAllSinglesInGroup"];
    if (v) _pickAllSinglesInGroup = [v boolValue];
    else { v = dict[@"pickSingleInGroup"]; if (v) _pickAllSinglesInGroup = [v boolValue]; } // migrate v6.1
    v = dict[@"pickAllSinglesInGroupMinDistance"];
    if (v) _pickAllSinglesInGroupMinDistance = [v integerValue];
    else { v = dict[@"pickSingleInGroupMinDistance"]; if (v) _pickAllSinglesInGroupMinDistance = [v integerValue]; }
    v = dict[@"refreshIntervalMs"]; if (v) _refreshIntervalMs = [v integerValue];
    v = dict[@"requestMaxDistance"]; if (v) _requestMaxDistance = [v integerValue];
    v = dict[@"minPrice"]; if (v) _minPrice = [v integerValue];
    v = dict[@"maxPrice"]; if (v) _maxPrice = [v integerValue];
    v = dict[@"minDistance"]; if (v) _minDistance = [v integerValue];
    v = dict[@"maxDistance"]; if (v) _maxDistance = [v integerValue];
    v = dict[@"minCOD"]; if (v) _minCOD = [v integerValue];
    v = dict[@"maxCOD"]; if (v) _maxCOD = [v integerValue];
    v = dict[@"maxOrders"]; if (v) _maxOrdersPerSession = [v integerValue];
    v = dict[@"cooldown"]; if (v) _cooldown = [v doubleValue];
    v = dict[@"preferredCategories"]; if (v) _preferredCategories = v;
    v = dict[@"preferredDistricts"]; if (v) _preferredDistricts = v;
    v = dict[@"districtFilterMode"]; if (v) _districtFilterMode = [v integerValue];
    v = dict[@"blockedURL"]; if ([v isKindOfClass:[NSString class]]) _blockedURL = v;
    v = dict[@"orderDataUploadEnabled"]; if (v) _orderDataUploadEnabled = [v boolValue];
    v = dict[@"orderDataUploadToken"]; if ([v isKindOfClass:[NSString class]]) _orderDataUploadToken = v;

    if (_refreshIntervalMs < 100) _refreshIntervalMs = 100;
    if (_refreshIntervalMs > 10000) _refreshIntervalMs = 10000;
    if (_requestMaxDistance < 500) _requestMaxDistance = 500;
    if (_requestMaxDistance > 50000) _requestMaxDistance = 50000;
}

- (void)save {
    NSDictionary *dict = @{
        @"enabled": @(_enabled),
        @"notifyOnAssignment": @(_notifyOnAssignment),
        @"autoRefresh": @(_autoRefresh),
        @"autoPick": @(_autoPick),
        @"stopAfterPick": @(_stopAfterPick),
        @"systemNotify": @(_systemNotify),
        @"notifyOnMatch": @(_notifyOnMatch),
        @"notifyOnSuccess": @(_notifyOnSuccess),
        @"soundOnMatch": @(_soundOnMatch),
        @"vibrateOnMatch": @(_vibrateOnMatch),
        @"verboseLog": @(_verboseLog),
        @"loggingEnabled": @(_loggingEnabled),
        @"pickAllSinglesInGroup": @(_pickAllSinglesInGroup),
        @"pickAllSinglesInGroupMinDistance": @(_pickAllSinglesInGroupMinDistance),
        @"refreshIntervalMs": @(_refreshIntervalMs),
        @"requestMaxDistance": @(_requestMaxDistance),
        @"minPrice": @(_minPrice),
        @"maxPrice": @(_maxPrice),
        @"minDistance": @(_minDistance),
        @"maxDistance": @(_maxDistance),
        @"minCOD": @(_minCOD),
        @"maxCOD": @(_maxCOD),
        @"maxOrders": @(_maxOrdersPerSession),
        @"cooldown": @(_cooldown),
        @"preferredCategories": _preferredCategories ?: @[],
        @"preferredDistricts": _preferredDistricts ?: @[],
        @"districtFilterMode": @(_districtFilterMode),
        @"blockedURL": _blockedURL ?: @"",
        @"orderDataUploadEnabled": @(_orderDataUploadEnabled),
        @"orderDataUploadToken": _orderDataUploadToken ?: @""
    };
    [dict writeToFile:[self filePath] atomically:YES];
    [[NSNotificationCenter defaultCenter] postNotificationName:@"APFPrefsDidChangeNotification" object:nil];
}

- (void)reset {
    [self setDefaults];
    [self save];
}

- (NSDictionary *)toDictionary {
    return @{
        @"enabled": @(_enabled),
        @"notifyOnAssignment": @(_notifyOnAssignment),
        @"autoRefresh": @(_autoRefresh),
        @"autoPick": @(_autoPick),
        @"stopAfterPick": @(_stopAfterPick),
        @"verboseLog": @(_verboseLog),
        @"loggingEnabled": @(_loggingEnabled),
        @"pickAllSinglesInGroup": @(_pickAllSinglesInGroup),
        @"pickAllSinglesInGroupMinDistance": @(_pickAllSinglesInGroupMinDistance),
        @"refreshIntervalMs": @(_refreshIntervalMs),
        @"requestMaxDistance": @(_requestMaxDistance),
        @"minPrice": @(_minPrice),
        @"maxPrice": @(_maxPrice),
        @"minDistance": @(_minDistance),
        @"maxDistance": @(_maxDistance),
        @"minCOD": @(_minCOD),
        @"maxCOD": @(_maxCOD),
        @"maxOrdersPerSession": @(_maxOrdersPerSession),
        @"cooldown": @(_cooldown),
        @"preferredCategories": _preferredCategories ?: @[],
        @"preferredDistricts": _preferredDistricts ?: @[],
        @"districtFilterMode": @(_districtFilterMode),
        @"blockedURL": _blockedURL ?: @"",
        @"orderDataUploadEnabled": @(_orderDataUploadEnabled),
        @"orderDataUploadToken": _orderDataUploadToken ?: @""
    };
}

@end
