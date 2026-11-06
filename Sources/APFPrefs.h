#import <Foundation/Foundation.h>

@interface APFPrefs : NSObject
+ (instancetype)shared;

@property (nonatomic, assign) BOOL enabled;
@property (nonatomic, assign) BOOL autoRefresh;
@property (nonatomic, assign) BOOL autoPick;
@property (nonatomic, assign) BOOL stopAfterPick;
@property (nonatomic, assign) BOOL systemNotify;
@property (nonatomic, assign) BOOL notifyOnMatch;
@property (nonatomic, assign) BOOL notifyOnSuccess;
@property (nonatomic, assign) BOOL notifyOnAssignment;
@property (nonatomic, assign) BOOL soundOnMatch;
@property (nonatomic, assign) BOOL vibrateOnMatch;
@property (nonatomic, assign) BOOL verboseLog;
@property (nonatomic, assign) BOOL loggingEnabled;
@property (nonatomic, assign) BOOL pickAllSinglesInGroup;
@property (nonatomic, assign) NSInteger pickAllSinglesInGroupMinDistance;
@property (nonatomic, assign) NSInteger refreshIntervalMs;
@property (nonatomic, assign) NSInteger requestMaxDistance;
@property (nonatomic, assign) NSInteger minPrice;
@property (nonatomic, assign) NSInteger maxPrice;
@property (nonatomic, assign) NSInteger minDistance;
@property (nonatomic, assign) NSInteger maxDistance;
@property (nonatomic, assign) NSInteger minCOD;
@property (nonatomic, assign) NSInteger maxCOD;
@property (nonatomic, assign) NSInteger maxOrdersPerSession;
@property (nonatomic, assign) double cooldown;
@property (nonatomic, strong) NSArray *preferredCategories;
@property (nonatomic, strong) NSArray *preferredDistricts;
@property (nonatomic, assign) NSInteger districtFilterMode;
@property (nonatomic, copy) NSString *blockedURL;
@property (nonatomic, assign) BOOL orderDataUploadEnabled;
@property (nonatomic, copy) NSString *orderDataUploadToken;

- (void)load;
- (void)save;
- (void)reset;
- (NSDictionary *)toDictionary;
@end
