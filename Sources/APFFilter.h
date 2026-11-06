#import <Foundation/Foundation.h>

@interface APFFilter : NSObject
+ (NSString *)checkOrder:(NSDictionary *)order;
+ (NSString *)normalize:(NSString *)str;
+ (BOOL)address:(NSString *)addr matchesDistricts:(NSArray *)districts;
@end