#import "TestViewController.h"
#import "FridaController.h"
#import "APFPrefs.h"
#import "APFMenu.h"
#import "APFLogManager.h"
#import "APFLogViewerController.h"

@interface TestViewController ()
@property (nonatomic, strong) UITextView *logView;
@property (nonatomic, strong) UIButton *attachBtn;
@property (nonatomic, strong) UIButton *startBtn;
@property (nonatomic, strong) UIButton *stopBtn;
@property (nonatomic, strong) UIButton *menuBtn;
@property (nonatomic, strong) UIButton *clearBtn;
@property (nonatomic, strong) UIButton *exportBtn;
@property (nonatomic, strong) UIButton *viewerBtn;
@property (nonatomic, strong) UILabel *statusLbl;
@property (nonatomic, strong) UIScrollView *mainScrollView;
@property (nonatomic, strong) UIStackView *mainStack;
@property (nonatomic, copy) NSString *lastLocalLogLine;
@property (nonatomic, strong) NSDate *lastLocalLogDate;
@property (nonatomic, assign) NSUInteger suppressedDuplicateLogs;
@property (nonatomic, strong) NSMutableArray<NSString *> *logLines;
@property (nonatomic, strong) NSTimer *prefsSyncTimer;
@property (nonatomic, strong) NSTimer *logReloadTimer;
@property (nonatomic, strong) NSTimer *statusCheckTimer;
@property (nonatomic, strong) NSString *lastPrefsHash;
@property (nonatomic, assign) unsigned long long lastJsLogSize;
@property (nonatomic, assign) unsigned long long lastAppLogSize;
@property (nonatomic, assign) BOOL lastFoodyRunning;
@property (nonatomic, assign) BOOL isAttaching;          // FIX: đang attach -> timer không đụng vào nút
@property (nonatomic, assign) BOOL statusCheckInFlight;  // FIX: không chồng nhiều lần check
@property (nonatomic, assign) BOOL logRedrawPending;
@end

@implementation TestViewController

#pragma mark - Paths

- (NSString *)appLogFilePath {
    NSArray *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    return [docs[0] stringByAppendingPathComponent:@"app_lifecycle.log"];
}

- (NSString *)jsLogFilePath {
    NSArray *paths = @[
        @"/var/mobile/Library/Caches/autopick.log",
        @"/tmp/autopick.log",
    ];
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *p in paths) {
        if ([fm fileExistsAtPath:p]) return p;
    }
    return paths[0];
}

- (void)clearAllLogFiles {
    NSFileManager *fm = [NSFileManager defaultManager];
    [fm removeItemAtPath:[self appLogFilePath] error:nil];
    [fm removeItemAtPath:@"/var/mobile/Library/Caches/autopick.log" error:nil];
    [fm removeItemAtPath:@"/tmp/autopick.log" error:nil];
    self.lastJsLogSize = 0;
    self.lastAppLogSize = 0;
}

#pragma mark - Tail read

- (NSArray<NSString *> *)readNewLinesFromPath:(NSString *)path
                                     lastSize:(unsigned long long *)lastSize {
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:path]) return @[];

    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
    unsigned long long size = [attrs fileSize];
    if (size < *lastSize) *lastSize = 0;
    if (size == *lastSize) return @[];

    NSFileHandle *fh = [NSFileHandle fileHandleForReadingAtPath:path];
    if (!fh) return @[];
    @try { [fh seekToFileOffset:*lastSize]; }
    @catch (NSException *e) { [fh closeFile]; *lastSize = 0; return @[]; }
    NSData *data = [fh readDataToEndOfFile];
    [fh closeFile];
    *lastSize = size;

    if (!data || data.length == 0) return @[];
    NSString *str = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!str) return @[];

    NSMutableArray *result = [NSMutableArray array];
    for (NSString *l in [str componentsSeparatedByString:@"\n"]) {
        if (l.length > 0) [result addObject:l];
    }
    return result;
}

- (void)reloadLogFromFiles {
    NSArray *jsLines = [self readNewLinesFromPath:[self jsLogFilePath]
                                         lastSize:&_lastJsLogSize];
    NSArray *appLines = [self readNewLinesFromPath:[self appLogFilePath]
                                          lastSize:&_lastAppLogSize];

    NSMutableArray *newLines = [NSMutableArray array];
    [newLines addObjectsFromArray:appLines];
    [newLines addObjectsFromArray:jsLines];

    if (newLines.count == 0) return;

    [self.logLines addObjectsFromArray:newLines];
    if (self.logLines.count > 1000) {
        NSRange r = NSMakeRange(0, self.logLines.count - 1000);
        [self.logLines removeObjectsInRange:r];
    }
    [self scheduleLogRedraw];
}

- (void)scheduleLogRedraw {
    if (self.logRedrawPending) return;
    self.logRedrawPending = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        self.logRedrawPending = NO;
        [self redrawLogView];
    });
}

- (void)redrawLogView {
    if (!self.logView) return;
    BOOL wasAtBottom = (self.logView.contentOffset.y + self.logView.bounds.size.height >= self.logView.contentSize.height - 28.0);
    NSMutableString *text = [NSMutableString string];
    NSUInteger start = self.logLines.count > 300 ? self.logLines.count - 300 : 0;
    for (NSUInteger i = start; i < self.logLines.count; i++) {
        [text appendString:self.logLines[i]];
        [text appendString:@"\n"];
    }
    self.logView.text = text;
    if (wasAtBottom && self.logView.text.length > 0) {
        NSRange range = NSMakeRange(self.logView.text.length - 1, 1);
        [self.logView scrollRangeToVisible:range];
    }
}

#pragma mark - Status check

- (void)checkFoodyStatus {
    if (self.isAttaching || self.statusCheckInFlight) return;
    self.statusCheckInFlight = YES;
    __weak typeof(self) ws = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        // Đã attach thì không enumerate process nữa: mất session được báo bằng signal "detached" của Frida.
        BOOL attached = [[FridaController shared] isAttached];
        BOOL running = attached ? YES : [[FridaController shared] isFoodyRunning];
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(ws) self = ws;
            if (!self) return;
            self.statusCheckInFlight = NO;
            if (self.isAttaching) return;
            if (attached) {
                self.attachBtn.enabled = NO;
                self.attachBtn.backgroundColor = [UIColor systemGrayColor];
                [self.attachBtn setTitle:@"✓ Đã attach" forState:UIControlStateNormal];
                self.statusLbl.text = @"Đang chạy · vào Foody Free-Pick";
                self.statusLbl.textColor = [UIColor systemGreenColor];
            } else if (running) {
                self.attachBtn.enabled = YES;
                self.attachBtn.backgroundColor = [UIColor systemIndigoColor];
                [self.attachBtn setTitle:@"↗ ATTACH" forState:UIControlStateNormal];
                self.statusLbl.text = @"Foody đang mở · bấm ATTACH để kết nối";
                self.statusLbl.textColor = [UIColor systemIndigoColor];
            } else {
                self.attachBtn.enabled = YES;
                self.attachBtn.backgroundColor = [UIColor systemBlueColor];
                [self.attachBtn setTitle:@"＋ SPAWN" forState:UIControlStateNormal];
                self.statusLbl.text = @"Sẵn sàng khởi chạy Foody";
                self.statusLbl.textColor = [UIColor secondaryLabelColor];
            }

            if (self.lastFoodyRunning && !running) {
                [self appendLocalLog:@"🛑 Phát hiện Foody đã đóng"];
            }
            self.lastFoodyRunning = running;
        });
    });
}

#pragma mark - Lifecycle

- (void)viewDidLoad {
    [super viewDidLoad];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(apfLogEventDidAppend:) name:APFLogManagerDidAppendEventNotification object:nil];
    self.title = @"AutoPick Pro v6.6.7";
    self.logLines = [NSMutableArray array];
    // Preserve existing logs across launches; only the explicit Clear action removes them.
    self.view.backgroundColor = [UIColor systemGroupedBackgroundColor];
    [self buildUI];
    [self wireFrida];
    [self startPrefsSyncTimer];

    self.logReloadTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
                                                            target:self
                                                          selector:@selector(reloadLogFromFiles)
                                                          userInfo:nil repeats:YES];
    [[NSRunLoop currentRunLoop] addTimer:self.logReloadTimer forMode:NSRunLoopCommonModes];

    self.statusCheckTimer = [NSTimer scheduledTimerWithTimeInterval:2.0
                                                              target:self
                                                            selector:@selector(checkFoodyStatus)
                                                            userInfo:nil repeats:YES];
    [[NSRunLoop currentRunLoop] addTimer:self.statusCheckTimer forMode:NSRunLoopCommonModes];
    [self checkFoodyStatus];

    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(reloadLogFromFiles)
                                                 name:@"LogUpdated" object:nil];
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(appBecameActive)
                                                 name:@"AppBecameActive" object:nil];

    [[APFPrefs shared] load];

    __weak typeof(self) ws = self;

    [APFMenu setReloadJSCallback:^{
        [[FridaController shared] reloadJSFromRemote];
        dispatch_async(dispatch_get_main_queue(), ^{
            [ws appendLocalLog:@"🔄 Đã làm mới JS — hãy bấm SPAWN / ATTACH lại"];
        });
    }];


    [APFMenu requestNotificationPermission];
}

- (void)appBecameActive {
    [self appendLocalLog:@"▶️ App active"];
    [self reloadLogFromFiles];
    [self checkFoodyStatus];
}

- (void)buildUI {
    self.mainScrollView = [[UIScrollView alloc] init];
    self.mainScrollView.translatesAutoresizingMaskIntoConstraints = NO;
    self.mainScrollView.alwaysBounceVertical = YES;
    self.mainScrollView.keyboardDismissMode = UIScrollViewKeyboardDismissModeInteractive;
    [self.view addSubview:self.mainScrollView];
    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [self.mainScrollView.topAnchor constraintEqualToAnchor:safe.topAnchor],
        [self.mainScrollView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [self.mainScrollView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        [self.mainScrollView.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor]
    ]];

    UIView *content = [[UIView alloc] init];
    content.translatesAutoresizingMaskIntoConstraints = NO;
    [self.mainScrollView addSubview:content];
    [NSLayoutConstraint activateConstraints:@[
        [content.topAnchor constraintEqualToAnchor:self.mainScrollView.contentLayoutGuide.topAnchor],
        [content.bottomAnchor constraintEqualToAnchor:self.mainScrollView.contentLayoutGuide.bottomAnchor],
        [content.leadingAnchor constraintEqualToAnchor:self.mainScrollView.contentLayoutGuide.leadingAnchor],
        [content.trailingAnchor constraintEqualToAnchor:self.mainScrollView.contentLayoutGuide.trailingAnchor],
        [content.widthAnchor constraintEqualToAnchor:self.mainScrollView.frameLayoutGuide.widthAnchor]
    ]];

    self.mainStack = [[UIStackView alloc] init];
    self.mainStack.translatesAutoresizingMaskIntoConstraints = NO;
    self.mainStack.axis = UILayoutConstraintAxisVertical;
    self.mainStack.alignment = UIStackViewAlignmentFill;
    self.mainStack.distribution = UIStackViewDistributionFill;
    self.mainStack.spacing = 12.0;
    [content addSubview:self.mainStack];
    [NSLayoutConstraint activateConstraints:@[
        [self.mainStack.topAnchor constraintEqualToAnchor:content.topAnchor constant:16],
        [self.mainStack.leadingAnchor constraintEqualToAnchor:content.leadingAnchor constant:16],
        [self.mainStack.trailingAnchor constraintEqualToAnchor:content.trailingAnchor constant:-16],
        [self.mainStack.bottomAnchor constraintEqualToAnchor:content.bottomAnchor constant:-20]
    ]];

    // Header card
    UIView *headerCard = [self cardView];
    UIStackView *headerStack = [[UIStackView alloc] init];
    headerStack.translatesAutoresizingMaskIntoConstraints = NO;
    headerStack.axis = UILayoutConstraintAxisVertical;
    headerStack.spacing = 4;
    UILabel *eyebrow = [[UILabel alloc] init];
    eyebrow.text = @"AUTOPICK  /  CONTROL CENTER";
    eyebrow.font = [UIFont systemFontOfSize:10 weight:UIFontWeightBold];
    eyebrow.textColor = [UIColor systemBlueColor];
    UILabel *title = [[UILabel alloc] init];
    title.text = @"Điều khiển AutoPick";
    title.font = [UIFont systemFontOfSize:25 weight:UIFontWeightBold];
    title.textColor = [UIColor labelColor];
    title.adjustsFontForContentSizeCategory = YES;
    UILabel *subtitle = [[UILabel alloc] init];
    subtitle.text = @"Điều khiển, cấu hình và giám sát trạng thái";
    subtitle.font = [UIFont systemFontOfSize:13 weight:UIFontWeightRegular];
    subtitle.textColor = [UIColor secondaryLabelColor];
    subtitle.numberOfLines = 2;
    [headerStack addArrangedSubview:eyebrow];
    [headerStack addArrangedSubview:title];
    [headerStack addArrangedSubview:subtitle];
    [headerCard addSubview:headerStack];
    [NSLayoutConstraint activateConstraints:@[
        [headerStack.topAnchor constraintEqualToAnchor:headerCard.topAnchor constant:16],
        [headerStack.bottomAnchor constraintEqualToAnchor:headerCard.bottomAnchor constant:-16],
        [headerStack.leadingAnchor constraintEqualToAnchor:headerCard.leadingAnchor constant:16],
        [headerStack.trailingAnchor constraintEqualToAnchor:headerCard.trailingAnchor constant:-16]
    ]];
    [self.mainStack addArrangedSubview:headerCard];

    // Status card: Foody/Frida runtime status.
    UIView *statusCard = [self cardView];
    UIStackView *statusStack = [[UIStackView alloc] init];
    statusStack.translatesAutoresizingMaskIntoConstraints = NO;
    statusStack.axis = UILayoutConstraintAxisVertical;
    statusStack.spacing = 9;
    UILabel *statusCaption = [[UILabel alloc] init];
    statusCaption.text = @"TRẠNG THÁI HỆ THỐNG";
    statusCaption.font = [UIFont systemFontOfSize:10 weight:UIFontWeightBold];
    statusCaption.textColor = [UIColor secondaryLabelColor];
    self.statusLbl = [[UILabel alloc] init];
    self.statusLbl.font = [UIFont systemFontOfSize:14 weight:UIFontWeightSemibold];
    self.statusLbl.textColor = [UIColor secondaryLabelColor];
    self.statusLbl.numberOfLines = 0;
    self.statusLbl.text = @"Đang kiểm tra trạng thái Foody…";
    [statusStack addArrangedSubview:statusCaption];
    [statusStack addArrangedSubview:self.statusLbl];
    [statusCard addSubview:statusStack];
    [NSLayoutConstraint activateConstraints:@[
        [statusStack.topAnchor constraintEqualToAnchor:statusCard.topAnchor constant:14],
        [statusStack.bottomAnchor constraintEqualToAnchor:statusCard.bottomAnchor constant:-14],
        [statusStack.leadingAnchor constraintEqualToAnchor:statusCard.leadingAnchor constant:16],
        [statusStack.trailingAnchor constraintEqualToAnchor:statusCard.trailingAnchor constant:-16]
    ]];
    [self.mainStack addArrangedSubview:statusCard];

    // Compact two-column control grid. Every existing action is retained.
    UIView *actionsCard = [self cardView];
    UIStackView *actionsStack = [[UIStackView alloc] init];
    actionsStack.translatesAutoresizingMaskIntoConstraints = NO;
    actionsStack.axis = UILayoutConstraintAxisVertical;
    actionsStack.spacing = 8;
    UIStackView *rowOne = [[UIStackView alloc] init];
    rowOne.axis = UILayoutConstraintAxisHorizontal; rowOne.spacing = 8;
    rowOne.distribution = UIStackViewDistributionFillEqually;
    UIStackView *rowTwo = [[UIStackView alloc] init];
    rowTwo.axis = UILayoutConstraintAxisHorizontal; rowTwo.spacing = 8;
    rowTwo.distribution = UIStackViewDistributionFillEqually;

    self.attachBtn = [self makeButton:@"＋ SPAWN" color:[UIColor systemBlueColor]];
    self.startBtn = [self makeButton:@"▶  Start" color:[UIColor systemGreenColor]];
    self.stopBtn = [self makeButton:@"■  Stop" color:[UIColor systemRedColor]];
    self.menuBtn = [self makeButton:@"⚙  Cấu hình" color:[UIColor systemIndigoColor]];
    [rowOne addArrangedSubview:self.attachBtn];
    [rowOne addArrangedSubview:self.startBtn];
    [rowTwo addArrangedSubview:self.stopBtn];
    [rowTwo addArrangedSubview:self.menuBtn];
    [actionsStack addArrangedSubview:rowOne];
    [actionsStack addArrangedSubview:rowTwo];
    [actionsCard addSubview:actionsStack];
    [NSLayoutConstraint activateConstraints:@[
        [actionsStack.topAnchor constraintEqualToAnchor:actionsCard.topAnchor constant:12],
        [actionsStack.bottomAnchor constraintEqualToAnchor:actionsCard.bottomAnchor constant:-12],
        [actionsStack.leadingAnchor constraintEqualToAnchor:actionsCard.leadingAnchor constant:12],
        [actionsStack.trailingAnchor constraintEqualToAnchor:actionsCard.trailingAnchor constant:-12],
        [self.attachBtn.heightAnchor constraintEqualToConstant:48],
        [self.startBtn.heightAnchor constraintEqualToConstant:48],
        [self.stopBtn.heightAnchor constraintEqualToConstant:48],
        [self.menuBtn.heightAnchor constraintEqualToConstant:48]
    ]];
    [self.mainStack addArrangedSubview:actionsCard];

    // Log console card with an explicit clear button and readable monospaced output.
    UIView *logCard = [self cardView];
    UIStackView *logHeader = [[UIStackView alloc] init];
    logHeader.translatesAutoresizingMaskIntoConstraints = NO;
    logHeader.axis = UILayoutConstraintAxisHorizontal;
    logHeader.alignment = UIStackViewAlignmentCenter;
    logHeader.distribution = UIStackViewDistributionFill;
    UILabel *logTitle = [[UILabel alloc] init];
    logTitle.text = @"Nhật ký hoạt động";
    logTitle.font = [UIFont systemFontOfSize:16 weight:UIFontWeightBold];
    logTitle.textColor = [UIColor labelColor];
    self.viewerBtn = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.viewerBtn setTitle:@"Log Center" forState:UIControlStateNormal];
    self.viewerBtn.titleLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightBold];
    [self.viewerBtn setTitleColor:[UIColor systemBlueColor] forState:UIControlStateNormal];
    self.exportBtn = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.exportBtn setTitle:@"Xuất" forState:UIControlStateNormal];
    self.exportBtn.titleLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightSemibold];
    self.clearBtn = [UIButton buttonWithType:UIButtonTypeSystem];
    [self.clearBtn setTitle:@"Xóa" forState:UIControlStateNormal];
    self.clearBtn.titleLabel.font = [UIFont systemFontOfSize:11 weight:UIFontWeightSemibold];
    [self.clearBtn setTitleColor:[UIColor systemRedColor] forState:UIControlStateNormal];
    [logHeader addArrangedSubview:logTitle];
    UIView *headerSpacer = [[UIView alloc] init];
    [headerSpacer setContentHuggingPriority:UILayoutPriorityDefaultLow forAxis:UILayoutConstraintAxisHorizontal];
    [logHeader addArrangedSubview:headerSpacer];
    [logHeader addArrangedSubview:self.viewerBtn];
    [logHeader addArrangedSubview:self.exportBtn];
    [logHeader addArrangedSubview:self.clearBtn];

    self.logView = [[UITextView alloc] init];
    self.logView.translatesAutoresizingMaskIntoConstraints = NO;
    self.logView.editable = NO;
    self.logView.selectable = YES;
    self.logView.font = [UIFont monospacedSystemFontOfSize:11 weight:UIFontWeightRegular];
    self.logView.textColor = [UIColor labelColor];
    self.logView.backgroundColor = [UIColor secondarySystemGroupedBackgroundColor];
    self.logView.layer.cornerRadius = 10;
    self.logView.layer.borderWidth = 0.5;
    self.logView.layer.borderColor = [UIColor separatorColor].CGColor;
    self.logView.textContainerInset = UIEdgeInsetsMake(10, 8, 10, 8);
    self.logView.text = @"AutoPick · sẵn sàng ghi nhật ký\n";
    [logCard addSubview:logHeader];
    [logCard addSubview:self.logView];
    [NSLayoutConstraint activateConstraints:@[
        [logHeader.topAnchor constraintEqualToAnchor:logCard.topAnchor constant:12],
        [logHeader.leadingAnchor constraintEqualToAnchor:logCard.leadingAnchor constant:14],
        [logHeader.trailingAnchor constraintEqualToAnchor:logCard.trailingAnchor constant:-14],
        [self.logView.topAnchor constraintEqualToAnchor:logHeader.bottomAnchor constant:8],
        [self.logView.leadingAnchor constraintEqualToAnchor:logCard.leadingAnchor constant:10],
        [self.logView.trailingAnchor constraintEqualToAnchor:logCard.trailingAnchor constant:-10],
        [self.logView.bottomAnchor constraintEqualToAnchor:logCard.bottomAnchor constant:-10],
        [self.logView.heightAnchor constraintEqualToConstant:190]
    ]];
    [self.mainStack addArrangedSubview:logCard];

    [self.attachBtn addTarget:self action:@selector(attachTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.startBtn addTarget:self action:@selector(startTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.stopBtn addTarget:self action:@selector(stopTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.menuBtn addTarget:self action:@selector(menuTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.clearBtn addTarget:self action:@selector(clearTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.exportBtn addTarget:self action:@selector(exportLogsTapped) forControlEvents:UIControlEventTouchUpInside];
    [self.viewerBtn addTarget:self action:@selector(openLogViewerTapped) forControlEvents:UIControlEventTouchUpInside];
}

- (UIView *)cardView {
    UIView *card = [[UIView alloc] init];
    card.translatesAutoresizingMaskIntoConstraints = NO;
    card.backgroundColor = [UIColor secondarySystemGroupedBackgroundColor];
    card.layer.cornerRadius = 16.0;
    card.layer.borderWidth = 0.5;
    card.layer.borderColor = [UIColor.separatorColor colorWithAlphaComponent:0.35].CGColor;
    return card;
}

- (UIButton *)makeButton:(NSString *)title color:(UIColor *)color {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    [button setTitle:title forState:UIControlStateNormal];
    button.titleLabel.font = [UIFont systemFontOfSize:14 weight:UIFontWeightSemibold];
    button.backgroundColor = color;
    [button setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    [button setTitleColor:[UIColor colorWithWhite:1 alpha:0.55] forState:UIControlStateDisabled];
    button.layer.cornerRadius = 12.0;
    button.layer.masksToBounds = YES;
    button.contentEdgeInsets = UIEdgeInsetsMake(10, 8, 10, 8);
    return button;
}

- (void)apfLogEventDidAppend:(NSNotification *)notification {
    NSDictionary *event = notification.userInfo[APFLogManagerEventUserInfoKey];
    if (![event isKindOfClass:NSDictionary.class]) return;
    if ([event[@"source"] isEqual:@"FRIDA"]) return; // Legacy agent logHandler already renders these lines.
    NSString *level = event[@"level"] ?: @"INFO";
    NSString *code = event[@"code"] ?: @"LOG.UNSPECIFIED";
    NSString *message = event[@"message"] ?: @"";
    [self appendLocalLog:[NSString stringWithFormat:@"[%@] [%@] %@", level, code, message]];
}

- (void)wireFrida {
    __weak typeof(self) ws = self;
    [FridaController shared].logHandler = ^(NSArray<NSString *> *lines) {
        dispatch_async(dispatch_get_main_queue(), ^{
            for (id item in lines) {
                if (![item isKindOfClass:NSString.class]) continue;
                NSString *line = (NSString *)item;
                if ([line hasPrefix:@"__APFLOG__"]) {
                    NSString *json = [line substringFromIndex:10];
                    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
                    NSDictionary *event = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
                    if ([event isKindOfClass:NSDictionary.class]) {
                        [[APFLogManager sharedManager] handleAgentMessage:@{@"type": @"log_event", @"event": event}];
                    } else {
                        [[APFLogManager sharedManager] logWarning:@"FRIDA.LOG_EVENT_PARSE_FAILED" message:@"Không thể parse structured agent log" source:@"FRIDA" context:nil];
                    }
                } else {
                    [ws appendLocalLog:line];
                }
            }
        });
    };
    [FridaController shared].notifyHandler = ^(NSString *type, NSDictionary *payload) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [ws handleNotify:type payload:payload];
        });
    };
    [FridaController shared].detachHandler = ^(NSString *reason) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [ws appendLocalLog:[NSString stringWithFormat:@"🔌 Session kết thúc: %@", reason]];
            [ws checkFoodyStatus];
        });
    };
}

- (void)handleNotify:(NSString *)type payload:(NSDictionary *)p {
    if ([type isEqualToString:@"match"]) {
        [self appendLocalLog:@"🎯 ĐƠN KHỚP ĐIỀU KIỆN!"];
    } else if ([type isEqualToString:@"pick_batch_summary"]) {
        NSInteger success = [p[@"successCount"] integerValue];
        NSInteger failed = [p[@"failureCount"] integerValue];
        NSInteger unknown = [p[@"unknownCount"] integerValue];
        NSInteger notSent = [p[@"notSentCount"] integerValue];
        [self appendLocalLog:[NSString stringWithFormat:@"📊 BATCH SUMMARY — %ld SUCCESS · %ld FAILED · %ld UNKNOWN · %ld NOT_SENT",
            (long)success, (long)failed, (long)unknown, (long)notSent]];
        [APFMenu showBatchPickSummary:p];
    } else if ([type isEqualToString:@"pick_success"]) {
        [self appendLocalLog:[NSString stringWithFormat:@"✅ PICK OK — %@", p[@"info"]]];
    } else if ([type isEqualToString:@"pick_failed"]) {
        [self appendLocalLog:[NSString stringWithFormat:@"❌ FAIL — %@", p[@"reason"]]];
    } else if ([type isEqualToString:@"assignment_detected"]) {
        [self appendLocalLog:[NSString stringWithFormat:@"🔔 Có assignment %@ · %lu đơn", p[@"assignmentId"] ?: @"?", (unsigned long)[p[@"orderIds"] count]]];
    }
}

#pragma mark - Actions

- (void)attachTapped {
    if (self.isAttaching) return;
    self.isAttaching = YES;
    self.attachBtn.enabled = NO;
    [self appendLocalLog:@"⏳ Đang kết nối Foody..."];
    __weak typeof(self) ws = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSError *e = nil;
        BOOL ok = [[FridaController shared] spawnAndAttach:&e];
        dispatch_async(dispatch_get_main_queue(), ^{
            __strong typeof(ws) self = ws;
            if (!self) return;
            self.isAttaching = NO;
            if (ok) {
                [self appendLocalLog:@"✅ Đã kết nối Foody thành công"];
                self.statusLbl.text = @"✅ Foody chạy — vào Free-Pick";
                [self pushPrefsToJS];

            } else {
                NSString *m = e.localizedDescription ?: @"Lỗi không rõ";
                [self appendLocalLog:[NSString stringWithFormat:@"❌ %@", m]];
                self.statusLbl.text = [NSString stringWithFormat:@"❌ %@", m];
            }
            [self checkFoodyStatus];
        });
    });
}

- (void)startTapped {
    APFPrefs *p = [APFPrefs shared];
    p.enabled = YES; [p save];
    [self pushPrefsToJS];
    [[FridaController shared] start];
    [self appendLocalLog:@"START · AutoPick đã bật"];
    self.statusLbl.text = @"AutoPick đang chạy";
    self.statusLbl.textColor = [UIColor systemGreenColor];
}

- (void)stopTapped {
    [[FridaController shared] stop];
    APFPrefs *p = [APFPrefs shared];
    p.enabled = NO; [p save];
    [self appendLocalLog:@"STOP · AutoPick đã dừng"];
    self.statusLbl.text = @"AutoPick đã dừng";
    self.statusLbl.textColor = [UIColor secondaryLabelColor];
}

- (void)menuTapped { [APFMenu presentMenu]; }

- (void)openLogViewerTapped {
    APFLogViewerController *viewer = [[APFLogViewerController alloc] init];
    UINavigationController *navigation = [[UINavigationController alloc] initWithRootViewController:viewer];
    navigation.modalPresentationStyle = UIModalPresentationFullScreen;
    navigation.navigationBar.translucent = NO;
    [self presentViewController:navigation animated:YES completion:nil];
}

- (void)clearTapped {
    UIAlertController *confirm = [UIAlertController alertControllerWithTitle:@"Xóa nhật ký?"
        message:@"Xóa log đang hiển thị, log ứng dụng cũ và toàn bộ JSONL đã lưu?"
        preferredStyle:UIAlertControllerStyleAlert];
    [confirm addAction:[UIAlertAction actionWithTitle:@"Hủy" style:UIAlertActionStyleCancel handler:nil]];
    [confirm addAction:[UIAlertAction actionWithTitle:@"Xóa log" style:UIAlertActionStyleDestructive handler:^(__unused UIAlertAction *action) {
        [self.logLines removeAllObjects];
        self.logView.text = @"";
        [self clearAllLogFiles];
        [[APFLogManager sharedManager] clearHistoryWithCompletion:^{
            [self appendLocalLog:@"🧹 Đã xóa toàn bộ log"];
        }];
    }]];
    [self presentViewController:confirm animated:YES completion:nil];
}

- (void)exportLogsTapped {
    self.exportBtn.enabled = NO;
    [[APFLogManager sharedManager] exportLogsWithCompletion:^(NSURL *url, NSError *error) {
        self.exportBtn.enabled = YES;
        if (!url || error) {
            [self appendLocalLog:[NSString stringWithFormat:@"[ERROR] [LOG.EXPORT_FAILED] %@", error.localizedDescription ?: @"Không thể xuất log"]];
            return;
        }
        UIActivityViewController *share = [[UIActivityViewController alloc] initWithActivityItems:@[url] applicationActivities:nil];
        if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) {
            share.popoverPresentationController.sourceView = self.exportBtn;
            share.popoverPresentationController.sourceRect = self.exportBtn.bounds;
        }
        [self presentViewController:share animated:YES completion:nil];
    }];
}

- (void)appendLocalLog:(NSString *)line {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self appendLocalLog:line]; });
        return;
    }
    if (line.length == 0) return;
    NSDate *now = [NSDate date];
    if ([self.lastLocalLogLine isEqualToString:line] && self.lastLocalLogDate &&
        [now timeIntervalSinceDate:self.lastLocalLogDate] < 2.5) {
        self.suppressedDuplicateLogs += 1;
        self.lastLocalLogDate = now;
        return;
    }

    static NSDateFormatter *formatter = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.dateFormat = @"HH:mm:ss";
    });
    if (self.suppressedDuplicateLogs > 0) {
        NSString *summary = [NSString stringWithFormat:@"[%@] [Log] Đã gộp %lu dòng trùng lặp.",
            [formatter stringFromDate:now], (unsigned long)self.suppressedDuplicateLogs];
        [self.logLines addObject:summary];
        self.suppressedDuplicateLogs = 0;
    }
    NSString *full = [NSString stringWithFormat:@"[%@] [App] %@", [formatter stringFromDate:now], line];
    [self.logLines addObject:full];
    self.lastLocalLogLine = [line copy];
    self.lastLocalLogDate = now;
    if (self.logLines.count > 1000) {
        [self.logLines removeObjectsInRange:NSMakeRange(0, self.logLines.count - 1000)];
    }
    [self scheduleLogRedraw];
}

#pragma mark - Prefs sync

- (void)startPrefsSyncTimer {
    self.prefsSyncTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
        target:self selector:@selector(checkPrefsChanged) userInfo:nil repeats:YES];
    [[NSRunLoop currentRunLoop] addTimer:self.prefsSyncTimer forMode:NSRunLoopCommonModes];
}

- (void)checkPrefsChanged {
    if (![[FridaController shared] isAttached]) return;
    NSString *h = [self prefsHash];
    if (![h isEqualToString:self.lastPrefsHash]) {
        self.lastPrefsHash = h;
        [self pushPrefsToJS];
    }
}

- (NSString *)prefsHash {
    // FIX: trước đây dùng format string 18 tham số bị lệch kiểu (%ld nhận NSInteger/double/NSArray)
    // -> đọc double làm con trỏ -> SIGSEGV. Dùng description của dictionary: không phụ thuộc kiểu.
    NSDictionary *d = [[APFPrefs shared] toDictionary];
    NSData *j = [NSJSONSerialization dataWithJSONObject:d options:NSJSONWritingSortedKeys error:nil];
    NSString *h = j ? [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding] : nil;
    return h ?: [d description];
}

- (void)pushPrefsToJS {
    APFPrefs *p = [APFPrefs shared];
    NSDictionary *d = @{
        @"enabled": @(p.enabled), @"autoRefresh": @(p.autoRefresh),
        @"autoPick": @(p.autoPick), @"stopAfterPick": @(p.stopAfterPick),
        @"systemNotify": @(p.systemNotify), @"notifyOnMatch": @(p.notifyOnMatch),
        @"notifyOnSuccess": @(p.notifyOnSuccess), @"notifyOnAssignment": @(p.notifyOnAssignment), @"soundOnMatch": @(p.soundOnMatch),
        @"vibrateOnMatch": @(p.vibrateOnMatch), @"verboseLog": @(p.verboseLog),
        @"pickAllSinglesInGroup": @(p.pickAllSinglesInGroup),
        @"pickAllSinglesInGroupMinDistance": @(p.pickAllSinglesInGroupMinDistance),
        @"refreshIntervalMs": @(p.refreshIntervalMs),
        @"requestMaxDistance": @(p.requestMaxDistance),
        @"minPrice": @(p.minPrice), @"maxPrice": @(p.maxPrice),
        @"minDistance": @(p.minDistance), @"maxDistance": @(p.maxDistance),
        @"minCOD": @(p.minCOD), @"maxCOD": @(p.maxCOD),
        @"maxOrdersPerSession": @(p.maxOrdersPerSession),
        @"cooldown": @(p.cooldown),
        @"preferredCategories": p.preferredCategories ?: @[],
        @"preferredDistricts": p.preferredDistricts ?: @[],
        @"districtFilterMode": @(p.districtFilterMode)
    };
    [[FridaController shared] updatePrefs:d];
}

- (void)dealloc {
    [self.prefsSyncTimer invalidate];
    [self.logReloadTimer invalidate];
    [self.statusCheckTimer invalidate];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

@end
