#import "APFLogViewerController.h"
#import "APFLogManager.h"

@interface APFLogViewerController () <UITableViewDataSource, UITableViewDelegate, UISearchBarDelegate>
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *events;
@property (nonatomic, strong) NSMutableSet<NSString *> *eventIDs;
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *pendingLiveEvents;
@property (nonatomic, strong) UITableView *tableView;
@property (nonatomic, strong) UISearchBar *searchBar;
@property (nonatomic, strong) UISegmentedControl *levelControl;
@property (nonatomic, strong) UIScrollView *stageScrollView;
@property (nonatomic, strong) UIStackView *stageStack;
@property (nonatomic, strong) UILabel *liveLabel;
@property (nonatomic, strong) UILabel *visibleCountLabel;
@property (nonatomic, strong) NSArray<NSString *> *stageNames;
@property (nonatomic, strong) NSArray<UILabel *> *statValueLabels;
@property (nonatomic, assign) NSInteger selectedStage;
@property (nonatomic, assign) BOOL liveUpdating;
@property (nonatomic, assign) BOOL initialLoadInFlight;
@property (nonatomic, assign) BOOL hasUnseenEvents;
@property (nonatomic, strong) UIBarButtonItem *exportItem;
@property (nonatomic, strong) UIBarButtonItem *clearItem;
@end

@interface APFLogDetailViewController : UIViewController
- (instancetype)initWithEvent:(NSDictionary *)event;
@end

@implementation APFLogViewerController

- (void)viewDidLoad {
    [super viewDidLoad];
    self.title = @"Log Center";
    self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
    self.events = [NSMutableArray array];
    self.eventIDs = [NSMutableSet set];
    self.pendingLiveEvents = [NSMutableArray array];
    self.stageNames = @[@"Tất cả", @"Spawn", @"Attach", @"Hook", @"Refresh", @"Filter", @"Pick", @"Response", @"Assignment"];
    self.liveUpdating = YES;
    self.selectedStage = 0;

    self.exportItem = [[UIBarButtonItem alloc] initWithTitle:@"Xuất" style:UIBarButtonItemStylePlain target:self action:@selector(exportTapped)];
    UIBarButtonItem *closeItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone target:self action:@selector(closeTapped)];
    self.navigationItem.rightBarButtonItems = @[closeItem, self.exportItem];
    self.clearItem = [[UIBarButtonItem alloc] initWithTitle:@"Xóa log" style:UIBarButtonItemStylePlain target:self action:@selector(clearTapped)];
    self.clearItem.tintColor = UIColor.systemRedColor;
    self.navigationItem.leftBarButtonItem = self.clearItem;

    [self buildUI];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(logEventDidAppend:) name:APFLogManagerDidAppendEventNotification object:nil];
    [self loadEvents];
}

- (void)buildUI {
    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    UIStackView *header = [[UIStackView alloc] init];
    header.translatesAutoresizingMaskIntoConstraints = NO;
    header.axis = UILayoutConstraintAxisVertical;
    header.spacing = 9.0;
    [self.view addSubview:header];

    UIStackView *titleStack = [[UIStackView alloc] init];
    titleStack.axis = UILayoutConstraintAxisVertical;
    titleStack.spacing = 2.0;
    UILabel *title = [[UILabel alloc] init];
    title.text = @"Nhật ký hệ thống";
    title.font = [UIFont systemFontOfSize:22 weight:UIFontWeightBold];
    title.textColor = UIColor.labelColor;
    UILabel *subtitle = [[UILabel alloc] init];
    subtitle.text = @"Theo dõi vòng đời, refresh, lọc đơn và kết quả PICK";
    subtitle.font = [UIFont systemFontOfSize:12 weight:UIFontWeightRegular];
    subtitle.textColor = UIColor.secondaryLabelColor;
    subtitle.numberOfLines = 2;
    [titleStack addArrangedSubview:title];
    [titleStack addArrangedSubview:subtitle];
    [header addArrangedSubview:titleStack];

    UIStackView *stats = [[UIStackView alloc] init];
    stats.axis = UILayoutConstraintAxisHorizontal;
    stats.spacing = 7.0;
    stats.distribution = UIStackViewDistributionFillEqually;
    NSMutableArray<UILabel *> *values = [NSMutableArray array];
    NSArray<NSString *> *names = @[@"TỔNG LOG", @"SUCCESS", @"FAILED", @"UNKNOWN"];
    NSArray<UIColor *> *colors = @[UIColor.labelColor, UIColor.systemGreenColor, UIColor.systemRedColor, UIColor.systemOrangeColor];
    for (NSUInteger i = 0; i < names.count; i++) {
        UIView *card = [[UIView alloc] init];
        card.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
        card.layer.cornerRadius = 11.0;
        card.layer.borderWidth = 0.5;
        card.layer.borderColor = [UIColor.separatorColor colorWithAlphaComponent:0.35].CGColor;
        UIStackView *stack = [[UIStackView alloc] init];
        stack.translatesAutoresizingMaskIntoConstraints = NO;
        stack.axis = UILayoutConstraintAxisVertical;
        stack.alignment = UIStackViewAlignmentCenter;
        stack.spacing = 2.0;
        UILabel *value = [[UILabel alloc] init];
        value.text = @"—";
        value.font = [UIFont monospacedDigitSystemFontOfSize:20 weight:UIFontWeightBold];
        value.textColor = colors[i];
        UILabel *name = [[UILabel alloc] init];
        name.text = names[i];
        name.font = [UIFont systemFontOfSize:8.5 weight:UIFontWeightBold];
        name.textColor = UIColor.secondaryLabelColor;
        [stack addArrangedSubview:value];
        [stack addArrangedSubview:name];
        [card addSubview:stack];
        [NSLayoutConstraint activateConstraints:@[
            [stack.topAnchor constraintEqualToAnchor:card.topAnchor constant:8],
            [stack.bottomAnchor constraintEqualToAnchor:card.bottomAnchor constant:-7],
            [stack.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:3],
            [stack.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-3]
        ]];
        [stats addArrangedSubview:card];
        [values addObject:value];
    }
    [stats.heightAnchor constraintEqualToConstant:58].active = YES;
    self.statValueLabels = values.copy;
    [header addArrangedSubview:stats];

    self.searchBar = [[UISearchBar alloc] init];
    self.searchBar.translatesAutoresizingMaskIntoConstraints = NO;
    self.searchBar.searchBarStyle = UISearchBarStyleMinimal;
    self.searchBar.placeholder = @"Tìm mã đơn, event code, nội dung...";
    self.searchBar.delegate = self;
    [header addArrangedSubview:self.searchBar];
    [self.searchBar.heightAnchor constraintEqualToConstant:40].active = YES;

    self.levelControl = [[UISegmentedControl alloc] initWithItems:@[@"Tất cả", @"OK", @"Warn", @"Lỗi", @"Unknown", @"Info"]];
    self.levelControl.selectedSegmentIndex = 0;
    self.levelControl.selectedSegmentTintColor = UIColor.systemBlueColor;
    [self.levelControl setTitleTextAttributes:@{NSForegroundColorAttributeName: UIColor.labelColor, NSFontAttributeName: [UIFont systemFontOfSize:10 weight:UIFontWeightMedium]} forState:UIControlStateNormal];
    [self.levelControl setTitleTextAttributes:@{NSForegroundColorAttributeName: UIColor.whiteColor, NSFontAttributeName: [UIFont systemFontOfSize:10 weight:UIFontWeightSemibold]} forState:UIControlStateSelected];
    [self.levelControl addTarget:self action:@selector(levelChanged) forControlEvents:UIControlEventValueChanged];
    [header addArrangedSubview:self.levelControl];
    [self.levelControl.heightAnchor constraintEqualToConstant:32].active = YES;

    self.stageScrollView = [[UIScrollView alloc] init];
    self.stageScrollView.translatesAutoresizingMaskIntoConstraints = NO;
    self.stageScrollView.showsHorizontalScrollIndicator = NO;
    self.stageStack = [[UIStackView alloc] init];
    self.stageStack.translatesAutoresizingMaskIntoConstraints = NO;
    self.stageStack.axis = UILayoutConstraintAxisHorizontal;
    self.stageStack.spacing = 6.0;
    [self.stageScrollView addSubview:self.stageStack];
    [NSLayoutConstraint activateConstraints:@[
        [self.stageStack.topAnchor constraintEqualToAnchor:self.stageScrollView.contentLayoutGuide.topAnchor],
        [self.stageStack.bottomAnchor constraintEqualToAnchor:self.stageScrollView.contentLayoutGuide.bottomAnchor],
        [self.stageStack.leadingAnchor constraintEqualToAnchor:self.stageScrollView.contentLayoutGuide.leadingAnchor],
        [self.stageStack.trailingAnchor constraintEqualToAnchor:self.stageScrollView.contentLayoutGuide.trailingAnchor],
        [self.stageStack.heightAnchor constraintEqualToAnchor:self.stageScrollView.frameLayoutGuide.heightAnchor]
    ]];
    [header addArrangedSubview:self.stageScrollView];
    [self.stageScrollView.heightAnchor constraintEqualToConstant:34].active = YES;
    [self rebuildStageButtons];

    UIStackView *liveRow = [[UIStackView alloc] init];
    liveRow.axis = UILayoutConstraintAxisHorizontal;
    liveRow.alignment = UIStackViewAlignmentCenter;
    liveRow.spacing = 6.0;
    UISwitch *liveSwitch = [[UISwitch alloc] init];
    liveSwitch.on = YES;
    liveSwitch.transform = CGAffineTransformMakeScale(0.78, 0.78);
    [liveSwitch addTarget:self action:@selector(liveSwitchChanged:) forControlEvents:UIControlEventValueChanged];
    [liveRow addArrangedSubview:liveSwitch];
    self.liveLabel = [[UILabel alloc] init];
    self.liveLabel.text = @"Live đang bật";
    self.liveLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightSemibold];
    self.liveLabel.textColor = UIColor.systemGreenColor;
    [liveRow addArrangedSubview:self.liveLabel];
    UIView *spacer = [[UIView alloc] init];
    [liveRow addArrangedSubview:spacer];
    self.visibleCountLabel = [[UILabel alloc] init];
    self.visibleCountLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightMedium];
    self.visibleCountLabel.textColor = UIColor.secondaryLabelColor;
    [liveRow addArrangedSubview:self.visibleCountLabel];
    [header addArrangedSubview:liveRow];

    self.tableView = [[UITableView alloc] initWithFrame:CGRectZero style:UITableViewStyleInsetGrouped];
    self.tableView.translatesAutoresizingMaskIntoConstraints = NO;
    self.tableView.backgroundColor = UIColor.systemGroupedBackgroundColor;
    self.tableView.dataSource = self;
    self.tableView.delegate = self;
    self.tableView.rowHeight = UITableViewAutomaticDimension;
    self.tableView.estimatedRowHeight = 72.0;
    UILabel *emptyLabel = [[UILabel alloc] initWithFrame:CGRectZero];
    emptyLabel.textAlignment = NSTextAlignmentCenter;
    emptyLabel.textColor = UIColor.secondaryLabelColor;
    emptyLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightMedium];
    emptyLabel.numberOfLines = 0;
    emptyLabel.hidden = YES;
    self.tableView.backgroundView = emptyLabel;
    self.tableView.separatorInset = UIEdgeInsetsMake(0, 15, 0, 15);
    [self.view addSubview:self.tableView];

    [NSLayoutConstraint activateConstraints:@[
        [header.topAnchor constraintEqualToAnchor:safe.topAnchor constant:8],
        [header.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:12],
        [header.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
        [self.tableView.topAnchor constraintEqualToAnchor:header.bottomAnchor constant:2],
        [self.tableView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [self.tableView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        [self.tableView.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor]
    ]];
}

- (void)rebuildStageButtons {
    for (UIView *view in self.stageStack.arrangedSubviews) {
        [self.stageStack removeArrangedSubview:view];
        [view removeFromSuperview];
    }
    [self.stageNames enumerateObjectsUsingBlock:^(NSString *name, NSUInteger idx, BOOL *stop) {
        UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
        button.tag = (NSInteger)idx;
        [button setTitle:name forState:UIControlStateNormal];
        button.titleLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightSemibold];
        button.contentEdgeInsets = UIEdgeInsetsMake(6, 11, 6, 11);
        button.layer.cornerRadius = 10.0;
        button.layer.masksToBounds = YES;
        [button addTarget:self action:@selector(stageTapped:) forControlEvents:UIControlEventTouchUpInside];
        [self.stageStack addArrangedSubview:button];
    }];
    [self updateStageButtonStyles];
}

- (void)updateStageButtonStyles {
    [self.stageStack.arrangedSubviews enumerateObjectsUsingBlock:^(UIView *view, NSUInteger idx, BOOL *stop) {
        UIButton *button = (UIButton *)view;
        BOOL selected = ((NSInteger)idx == self.selectedStage);
        button.backgroundColor = selected ? UIColor.systemBlueColor : UIColor.tertiarySystemGroupedBackgroundColor;
        [button setTitleColor:selected ? UIColor.whiteColor : UIColor.secondaryLabelColor forState:UIControlStateNormal];
    }];
}

- (void)loadEvents {
    if (self.initialLoadInFlight) return;
    self.initialLoadInFlight = YES;
    [[APFLogManager sharedManager] loadRecentEventsWithLimit:2000 completion:^(NSArray<NSDictionary *> *loaded) {
        [self.events removeAllObjects];
        [self.eventIDs removeAllObjects];
        // loadRecentEventsWithLimit returns newest first; keep that order.
        for (NSDictionary *event in loaded) {
            NSString *eventID = [event[@"event_id"] isKindOfClass:NSString.class] ? event[@"event_id"] : nil;
            if (eventID.length && [self.eventIDs containsObject:eventID]) continue;
            if (eventID.length) [self.eventIDs addObject:eventID];
            [self.events addObject:event];
        }
        for (NSDictionary *event in self.pendingLiveEvents) [self insertEvent:event];
        [self.pendingLiveEvents removeAllObjects];
        self.initialLoadInFlight = NO;
        self.hasUnseenEvents = NO;
        [self updateDashboard];
        [self.tableView reloadData];
    }];
}

- (void)logEventDidAppend:(NSNotification *)notification {
    NSDictionary *event = notification.userInfo[APFLogManagerEventUserInfoKey];
    if (![event isKindOfClass:NSDictionary.class]) return;
    if (self.initialLoadInFlight) {
        [self.pendingLiveEvents addObject:event];
        return;
    }
    if (!self.liveUpdating) {
        self.hasUnseenEvents = YES;
        self.liveLabel.text = @"Đang tạm dừng · có log mới";
        self.liveLabel.textColor = UIColor.systemOrangeColor;
        return;
    }
    if ([self insertEvent:event]) {
        [self updateDashboard];
        [self.tableView reloadData];
    }
}

- (BOOL)insertEvent:(NSDictionary *)event {
    if (![event isKindOfClass:NSDictionary.class]) return NO;
    NSString *eventID = [event[@"event_id"] isKindOfClass:NSString.class] ? event[@"event_id"] : nil;
    if (eventID.length && [self.eventIDs containsObject:eventID]) return NO;
    if (eventID.length) [self.eventIDs addObject:eventID];
    [self.events insertObject:event atIndex:0];
    if (self.events.count > 2000) {
        NSDictionary *removed = self.events.lastObject;
        NSString *removedID = [removed[@"event_id"] isKindOfClass:NSString.class] ? removed[@"event_id"] : nil;
        if (removedID) [self.eventIDs removeObject:removedID];
        [self.events removeLastObject];
    }
    return YES;
}

- (NSArray<NSDictionary *> *)filteredEvents {
    NSString *query = [(self.searchBar.text ?: @"") stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].lowercaseString;
    NSInteger levelIndex = self.levelControl.selectedSegmentIndex;
    NSInteger safeLevelIndex = MAX(0, MIN(levelIndex, 5));
    NSString *wantedLevel = @[@"", @"SUCCESS", @"WARNING", @"ERROR", @"UNKNOWN", @"INFO"][safeLevelIndex];
    NSMutableArray<NSDictionary *> *result = [NSMutableArray array];
    for (NSDictionary *event in self.events) {
        NSString *level = [event[@"level"] isKindOfClass:NSString.class] ? [event[@"level"] uppercaseString] : @"INFO";
        NSString *code = [event[@"code"] isKindOfClass:NSString.class] ? event[@"code"] : @"";
        NSString *message = [event[@"message"] isKindOfClass:NSString.class] ? event[@"message"] : @"";
        NSString *source = [event[@"source"] isKindOfClass:NSString.class] ? event[@"source"] : @"";
        if (safeLevelIndex == 4) {
            if (![code.uppercaseString containsString:@"UNKNOWN"] && ![message.uppercaseString containsString:@"UNKNOWN"]) continue;
        } else if (wantedLevel.length && ![level isEqualToString:wantedLevel]) {
            continue;
        }
        if (![self event:event matchesStageAtIndex:self.selectedStage]) continue;
        if (query.length) {
            NSString *contextText = @"";
            id context = event[@"context"];
            if ([NSJSONSerialization isValidJSONObject:context]) {
                NSData *data = [NSJSONSerialization dataWithJSONObject:context options:0 error:nil];
                contextText = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
            }
            NSString *haystack = [[NSString stringWithFormat:@"%@ %@ %@ %@ %@ %@", code, message, source, event[@"correlation_id"] ?: @"", event[@"event_id"] ?: @"", contextText] lowercaseString];
            if ([haystack rangeOfString:query].location == NSNotFound) continue;
        }
        [result addObject:event];
    }
    return result;
}

- (BOOL)event:(NSDictionary *)event matchesStageAtIndex:(NSInteger)index {
    if (index <= 0 || index >= (NSInteger)self.stageNames.count) return YES;
    NSString *codeValue = [event[@"code"] isKindOfClass:NSString.class] ? event[@"code"] : @"";
    NSString *sourceValue = [event[@"source"] isKindOfClass:NSString.class] ? event[@"source"] : @"";
    NSString *code = codeValue.uppercaseString;
    NSString *source = sourceValue.uppercaseString;
    NSArray<NSString *> *needles = @[@"", @"SPAWN", @"ATTACH", @"HOOK", @"REFRESH", @"FILTER", @"PICK", @"RESPONSE", @"ASSIGNMENT"];
    NSString *needle = needles[index];
    return [code containsString:needle] || (index == 2 && [source containsString:@"FRIDA"] && [code containsString:@"SESSION"]);
}

- (void)updateDashboard {
    NSUInteger success = 0, failed = 0, unknown = 0;
    for (NSDictionary *event in self.events) {
        NSString *codeValue = [event[@"code"] isKindOfClass:NSString.class] ? event[@"code"] : @"";
        NSString *levelValue = [event[@"level"] isKindOfClass:NSString.class] ? event[@"level"] : @"INFO";
        NSString *code = codeValue.uppercaseString;
        NSString *level = levelValue.uppercaseString;
        if ([code containsString:@"UNKNOWN"]) unknown++;
        else if ([code containsString:@"FAILED"] || [level isEqualToString:@"ERROR"]) failed++;
        else if ([code containsString:@"SUCCESS"] || [level isEqualToString:@"SUCCESS"]) success++;
    }
    NSArray<NSNumber *> *counts = @[@(self.events.count), @(success), @(failed), @(unknown)];
    [self.statValueLabels enumerateObjectsUsingBlock:^(UILabel *label, NSUInteger idx, BOOL *stop) {
        label.text = [NSString stringWithFormat:@"%@", counts[idx]];
    }];
    NSUInteger visibleCount = [self filteredEvents].count;
    self.visibleCountLabel.text = [NSString stringWithFormat:@"%lu kết quả", (unsigned long)visibleCount];
    UILabel *emptyLabel = (UILabel *)self.tableView.backgroundView;
    if (visibleCount == 0 && [emptyLabel isKindOfClass:UILabel.class]) {
        BOOL hasFilters = self.searchBar.text.length > 0 || self.selectedStage > 0 || self.levelControl.selectedSegmentIndex > 0;
        emptyLabel.text = hasFilters ? @"Không tìm thấy log phù hợp\nThử đổi từ khóa hoặc bộ lọc." : @"Chưa có nhật ký\nSự kiện mới sẽ xuất hiện tại đây.";
        emptyLabel.hidden = NO;
    } else if ([emptyLabel isKindOfClass:UILabel.class]) {
        emptyLabel.hidden = YES;
    }
}

- (NSString *)timeTextForEvent:(NSDictionary *)event {
    NSString *timestamp = [event[@"timestamp"] isKindOfClass:NSString.class] ? event[@"timestamp"] : @"";
    if (timestamp.length >= 19) {
        NSString *iso = [timestamp stringByReplacingOccurrencesOfString:@"Z" withString:@"+0000"];
        NSDateFormatter *input = [[NSDateFormatter alloc] init];
        input.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        input.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
        input.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSSZ";
        NSDate *date = [input dateFromString:iso];
        if (!date) {
            input.dateFormat = @"yyyy-MM-dd'T'HH:mm:ssZ";
            date = [input dateFromString:iso];
        }
        if (date) {
            NSDateFormatter *output = [[NSDateFormatter alloc] init];
            output.locale = [NSLocale currentLocale];
            output.timeZone = [NSTimeZone localTimeZone];
            output.dateFormat = @"HH:mm:ss";
            return [output stringFromDate:date];
        }
    }
    return timestamp.length >= 8 ? [timestamp substringToIndex:8] : @"--:--:--";
}

- (UIColor *)colorForLevel:(NSString *)level {
    NSString *value = level.uppercaseString;
    if ([value isEqualToString:@"SUCCESS"]) return UIColor.systemGreenColor;
    if ([value isEqualToString:@"WARNING"]) return UIColor.systemOrangeColor;
    if ([value isEqualToString:@"ERROR"]) return UIColor.systemRedColor;
    return UIColor.systemBlueColor;
}

#pragma mark - Controls

- (void)levelChanged { [self.tableView reloadData]; [self updateDashboard]; }

- (void)stageTapped:(UIButton *)sender {
    self.selectedStage = sender.tag;
    [self updateStageButtonStyles];
    [self.tableView reloadData];
    [self updateDashboard];
}

- (void)liveSwitchChanged:(UISwitch *)sender {
    self.liveUpdating = sender.isOn;
    if (self.liveUpdating) {
        self.liveLabel.text = @"Live đang bật";
        self.liveLabel.textColor = UIColor.systemGreenColor;
        self.hasUnseenEvents = NO;
        [self loadEvents];
    } else {
        self.liveLabel.text = @"Đang tạm dừng";
        self.liveLabel.textColor = UIColor.systemOrangeColor;
    }
}

- (void)searchBar:(UISearchBar *)searchBar textDidChange:(NSString *)searchText {
    [self.tableView reloadData];
    [self updateDashboard];
}

- (void)searchBarSearchButtonClicked:(UISearchBar *)searchBar { [searchBar resignFirstResponder]; }

- (void)closeTapped { [self dismissViewControllerAnimated:YES completion:nil]; }

- (void)exportTapped {
    self.exportItem.enabled = NO;
    [[APFLogManager sharedManager] exportLogsWithCompletion:^(NSURL *url, NSError *error) {
        self.exportItem.enabled = YES;
        if (!url || error) {
            UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Không thể xuất log" message:error.localizedDescription ?: @"Có lỗi khi tạo file log." preferredStyle:UIAlertControllerStyleAlert];
            [alert addAction:[UIAlertAction actionWithTitle:@"Đóng" style:UIAlertActionStyleDefault handler:nil]];
            [self presentViewController:alert animated:YES completion:nil];
            return;
        }
        UIActivityViewController *share = [[UIActivityViewController alloc] initWithActivityItems:@[url] applicationActivities:nil];
        if (share.popoverPresentationController) share.popoverPresentationController.barButtonItem = self.exportItem;
        [self presentViewController:share animated:YES completion:nil];
    }];
}

- (void)clearTapped {
    UIAlertController *confirm = [UIAlertController alertControllerWithTitle:@"Xóa log trung tâm?" message:@"Các file JSONL hiện tại và bản lưu trữ của APFLogManager sẽ bị xóa. Log legacy ở màn hình chính không bị ảnh hưởng bởi thao tác này." preferredStyle:UIAlertControllerStyleAlert];
    [confirm addAction:[UIAlertAction actionWithTitle:@"Hủy" style:UIAlertActionStyleCancel handler:nil]];
    [confirm addAction:[UIAlertAction actionWithTitle:@"Xóa log" style:UIAlertActionStyleDestructive handler:^(__unused UIAlertAction *action) {
        [[APFLogManager sharedManager] clearHistoryWithCompletion:^{
            [self.events removeAllObjects];
            [self.eventIDs removeAllObjects];
            [self.pendingLiveEvents removeAllObjects];
            [self.tableView reloadData];
            [self updateDashboard];
        }];
    }]];
    [self presentViewController:confirm animated:YES completion:nil];
}

#pragma mark - Table

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    return [self filteredEvents].count;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
    UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"APFLogCell"];
    if (!cell) cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:@"APFLogCell"];
    NSArray<NSDictionary *> *filtered = [self filteredEvents];
    NSDictionary *event = filtered[indexPath.row];
    NSString *levelValue = [event[@"level"] isKindOfClass:NSString.class] ? event[@"level"] : @"INFO";
    NSString *level = levelValue.uppercaseString;
    NSString *code = [event[@"code"] isKindOfClass:NSString.class] ? event[@"code"] : @"LOG.UNSPECIFIED";
    NSString *message = [event[@"message"] isKindOfClass:NSString.class] ? event[@"message"] : @"";
    NSString *source = [event[@"source"] isKindOfClass:NSString.class] ? event[@"source"] : @"APP";
    cell.textLabel.numberOfLines = 1;
    cell.textLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightBold];
    cell.textLabel.textColor = [self colorForLevel:level];
    cell.textLabel.text = [NSString stringWithFormat:@"%@  %@", level, code];
    cell.detailTextLabel.numberOfLines = 3;
    cell.detailTextLabel.font = [UIFont systemFontOfSize:12 weight:UIFontWeightRegular];
    cell.detailTextLabel.textColor = UIColor.secondaryLabelColor;
    cell.detailTextLabel.text = [NSString stringWithFormat:@"%@\n%@  ·  %@", message, source, [self timeTextForEvent:event]];
    cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
    cell.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
    [tableView deselectRowAtIndexPath:indexPath animated:YES];
    NSArray<NSDictionary *> *filtered = [self filteredEvents];
    if (indexPath.row >= filtered.count) return;
    APFLogDetailViewController *detail = [[APFLogDetailViewController alloc] initWithEvent:filtered[indexPath.row]];
    [self.navigationController pushViewController:detail animated:YES];
}

@end

@implementation APFLogDetailViewController {
    NSDictionary *_event;
}

- (instancetype)initWithEvent:(NSDictionary *)event {
    self = [super initWithNibName:nil bundle:nil];
    if (self) _event = [event copy] ?: @{};
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.title = @"Chi tiết log";
    self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
    self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc] initWithTitle:@"Sao chép" style:UIBarButtonItemStylePlain target:self action:@selector(copyTapped)];

    UILabel *code = [[UILabel alloc] init];
    code.translatesAutoresizingMaskIntoConstraints = NO;
    code.text = [_event[@"code"] isKindOfClass:NSString.class] ? _event[@"code"] : @"LOG.UNSPECIFIED";
    code.font = [UIFont systemFontOfSize:17 weight:UIFontWeightBold];
    code.textColor = UIColor.labelColor;
    code.numberOfLines = 0;

    UILabel *meta = [[UILabel alloc] init];
    meta.translatesAutoresizingMaskIntoConstraints = NO;
    meta.text = [NSString stringWithFormat:@"%@  ·  %@  ·  %@", _event[@"level"] ?: @"INFO", _event[@"source"] ?: @"APP", _event[@"timestamp"] ?: @""];
    meta.font = [UIFont systemFontOfSize:11 weight:UIFontWeightMedium];
    meta.textColor = UIColor.secondaryLabelColor;
    meta.numberOfLines = 0;

    UITextView *jsonView = [[UITextView alloc] init];
    jsonView.translatesAutoresizingMaskIntoConstraints = NO;
    jsonView.editable = NO;
    jsonView.selectable = YES;
    jsonView.alwaysBounceVertical = YES;
    jsonView.font = [UIFont monospacedSystemFontOfSize:11 weight:UIFontWeightRegular];
    jsonView.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    jsonView.layer.cornerRadius = 12.0;
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:_event options:NSJSONWritingPrettyPrinted error:&error];
    jsonView.text = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : [_event description];
    [self.view addSubview:code];
    [self.view addSubview:meta];
    [self.view addSubview:jsonView];
    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [code.topAnchor constraintEqualToAnchor:safe.topAnchor constant:16],
        [code.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:16],
        [code.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-16],
        [meta.topAnchor constraintEqualToAnchor:code.bottomAnchor constant:6],
        [meta.leadingAnchor constraintEqualToAnchor:code.leadingAnchor],
        [meta.trailingAnchor constraintEqualToAnchor:code.trailingAnchor],
        [jsonView.topAnchor constraintEqualToAnchor:meta.bottomAnchor constant:12],
        [jsonView.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:10],
        [jsonView.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-10],
        [jsonView.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-10]
    ]];
}

- (void)copyTapped {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:_event options:NSJSONWritingPrettyPrinted error:&error];
    NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : [_event description];
    UIPasteboard.generalPasteboard.string = text ?: @"";
    self.navigationItem.rightBarButtonItem.title = @"Đã chép";
}

@end
