#import "APFFilter.h"
#import "APFPrefs.h"

@implementation APFFilter

+ (NSString *)normalize:(NSString *)str {
    if (![str isKindOfClass:[NSString class]] || str.length == 0) return @"";
    NSMutableString *r = [[str lowercaseString] mutableCopy];
    [r replaceOccurrencesOfString:@"đ" withString:@"d" options:0 range:NSMakeRange(0, r.length)]; // đ không tách dấu được
    CFStringTransform((__bridge CFMutableStringRef)r, NULL, kCFStringTransformStripDiacritics, NO);
    NSString *out = r;
    out = [out stringByReplacingOccurrencesOfString:@"([a-z])(\\d)" withString:@"$1 $2"
        options:NSRegularExpressionSearch range:NSMakeRange(0, out.length)];
    out = [out stringByReplacingOccurrencesOfString:@"(\\d)([a-z])" withString:@"$1 $2"
        options:NSRegularExpressionSearch range:NSMakeRange(0, out.length)];
    out = [out stringByReplacingOccurrencesOfString:@"\\s+" withString:@" "
        options:NSRegularExpressionSearch range:NSMakeRange(0, out.length)];
    return [out stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

// Khớp nguyên cụm: "quan 1" không khớp "quan 10"
+ (BOOL)address:(NSString *)addr matchesDistricts:(NSArray *)districts {
    if (!addr || districts.count == 0) return NO;
    NSString *normAddr = [self normalize:addr];
    if (normAddr.length == 0) return NO;
    for (NSString *d in districts) {
        if (![d isKindOfClass:[NSString class]]) continue;
        NSString *normD = [self normalize:d];
        if (normD.length == 0) continue;
        NSString *pat = [NSString stringWithFormat:@"(^|[^a-z0-9])%@($|[^a-z0-9])",
                         [NSRegularExpression escapedPatternForString:normD]];
        NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:pat options:0 error:nil];
        if (re && [re firstMatchInString:normAddr options:0 range:NSMakeRange(0, normAddr.length)]) return YES;
    }
    return NO;
}

+ (NSString *)checkOrder:(NSDictionary *)order {
    APFPrefs *p = [APFPrefs shared];
    @try {
        NSInteger earnings = [order[@"total_earnings_amount"] integerValue];
        NSInteger distance = [order[@"delivery_distance"] integerValue];
        if (earnings < p.minPrice) return @"Giá thấp";
        if (p.maxPrice > 0 && earnings > p.maxPrice) return @"Giá cao";
        if (distance < p.minDistance) return @"Quá gần";
        if (p.maxDistance > 0 && distance > p.maxDistance) return @"Xa quá";
        NSInteger cod = 0;
        NSArray *inner = order[@"orders"];
        if ([inner isKindOfClass:[NSArray class]] && inner.count > 0)
            cod = [inner[0][@"cod_amount"] integerValue];
        if (cod < p.minCOD) return @"COD thấp";
        if (p.maxCOD > 0 && cod > p.maxCOD) return @"COD cao";
        if (p.preferredCategories.count > 0) {
            NSArray *dos = order[@"delivery_orders"];
            NSInteger cat = 0;
            if ([dos isKindOfClass:[NSArray class]] && dos.count > 0) {
                id c = dos[0][@"ref_order_category"];
                if (c) cat = [c integerValue];
            }
            BOOL found = NO;
            for (NSNumber *n in p.preferredCategories)
                if ([n integerValue] == cat) { found = YES; break; }
            if (!found) return [NSString stringWithFormat:@"Loại %ld", (long)cat];
        }
        if (p.districtFilterMode > 0 && p.preferredDistricts.count > 0) {
            NSArray *dos = order[@"delivery_orders"];
            if ([dos isKindOfClass:[NSArray class]] && dos.count > 0) {
                NSString *pickupAddr = nil;
                NSDictionary *pu = dos[0][@"pickup_address_info"];
                if ([pu isKindOfClass:[NSDictionary class]]) pickupAddr = pu[@"address"];
                NSString *dropoffAddr = nil;
                NSDictionary *last = dos[dos.count - 1];
                NSDictionary *do_ = last[@"dropoff_address_info"];
                if ([do_ isKindOfClass:[NSDictionary class]]) dropoffAddr = do_[@"address"];
                BOOL puM = [self address:pickupAddr matchesDistricts:p.preferredDistricts];
                BOOL doM = [self address:dropoffAddr matchesDistricts:p.preferredDistricts];
                BOOL pass = NO;
                if (p.districtFilterMode == 1) pass = puM;
                else if (p.districtFilterMode == 2) pass = doM;
                else if (p.districtFilterMode == 3) pass = puM || doM;
                if (!pass) return @"Quận khác";
            }
        }
        return nil;
    } @catch(NSException *e) { return @"Lỗi"; }
}

@end