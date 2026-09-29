// Exercise the actual Objective-C polling implementation without OS notifications.
#import "../../vendor/mac-notification-sys/objc/notify.m"
#include <assert.h>

static NSMutableSet<NSData*>* completed;
static NSMutableSet<NSData*>* confirmed;
static NSMutableDictionary<NSData*, NSString*>* outcomes;
static NSData* key(const unsigned char* bytes) {
    return [NSData dataWithBytes:bytes length:16];
}
static void finish(const unsigned char* bytes, NSString* outcome) {
    if (![completed containsObject:key(bytes)]) {
        [completed addObject:key(bytes)];
        outcomes[key(bytes)] = outcome;
    }
}
void rust_notification_activated(const unsigned char* bytes, uint8_t type, const char* value, int64_t index) {
    finish(bytes, @"clicked");
}
void rust_notification_dismissed(const unsigned char* bytes, const char* title) {
    finish(bytes, @"closed");
}
void rust_notification_auto_dismissed(const unsigned char* bytes) { finish(bytes, @"removed"); }
BOOL rust_notification_is_done(const unsigned char* bytes) { return [completed containsObject:key(bytes)]; }
BOOL rust_notification_is_delivered(const unsigned char* bytes) { return [confirmed containsObject:key(bytes)]; }
void rust_notification_delivered(const unsigned char* bytes) { [confirmed addObject:key(bytes)]; }
void rust_wait_for_notification(const unsigned char* bytes) { assert(!"unexpected blocking wait"); }
void rust_wait_for_delivery(const unsigned char* bytes) { assert(!"unexpected delivery wait"); }

@interface TestCenter: NSObject {
@public
    NSArray* notifications;
    NSUInteger reads;
    void (^onRead)(void);
}
- (NSArray*)deliveredNotifications;
@end
@implementation TestCenter
- (NSArray*)deliveredNotifications {
    reads++;
    if (onRead) onRead();
    return notifications;
}
@end

static NSUUID* track(BOOL delivered) {
    NSUUID* identifier = [NSUUID UUID];
    unsigned char bytes[16];
    [identifier getUUIDBytes:bytes];
    if (delivered) rust_notification_delivered(bytes);
    addDismissalWait(identifier);
    return identifier;
}
static void markDone(NSUUID* identifier) {
    unsigned char bytes[16];
    [identifier getUUIDBytes:bytes];
    rust_notification_activated(bytes, 2, NULL, -1);
}
static NSString* outcome(NSUUID* identifier) {
    unsigned char bytes[16];
    [identifier getUUIDBytes:bytes];
    return outcomes[key(bytes)];
}
static void tick(TestCenter* center) { pollDismissals((NSUserNotificationCenter*)center); }
static void reset(void) {
    for (NSUUID* identifier in [dismissalWaits allKeys]) removeDismissalWait(identifier);
    [completed removeAllObjects];
    [confirmed removeAllObjects];
    [outcomes removeAllObjects];
    assert(dismissalTimer == nil);
}

int main(void) {
    @autoreleasepool {
        assert([NSThread isMainThread]);
        completed = [NSMutableSet set];
        confirmed = [NSMutableSet set];
        outcomes = [NSMutableDictionary dictionary];
        TestCenter* center = [[[TestCenter alloc] init] autorelease];
        NSMutableArray* cards = [NSMutableArray array];
        NSMutableArray* ids = [NSMutableArray array];
        NSTimer* timer = nil;
        for (NSUInteger i = 0; i < 128; i++) {
            NSUUID* identifier = track(YES);
            [ids addObject:identifier];
            NSUserNotification* card = [[[NSUserNotification alloc] init] autorelease];
            card.identifier = identifier.UUIDString;
            [cards addObject:card];
            if (!timer) timer = dismissalTimer;
            assert(dismissalTimer == timer); // no per-card timer
            // Old cards stay actionable, rather than expiring to meet a budget.
            dismissalWaits[identifier] = [NSDate dateWithTimeIntervalSinceNow:-86400];
        }
        center->notifications = cards;
        tick(center);
        assert(center->reads == 1);
        assert(dismissalWaits.count == 128);
        assert(completed.count == 0);
        tick(center);
        assert(center->reads == 2);

        // Explicit completion frees registrations, with no query when all are done.
        for (NSUUID* identifier in ids) markDone(identifier);
        tick(center);
        assert(center->reads == 2);
        assert(dismissalWaits.count == 0 && dismissalTimer == nil);
        tick(center);
        assert(center->reads == 2);
        reset();

        // A dismissed card closes; a visible card still handles a later click.
        NSUUID* removed = track(YES);
        NSUUID* visible = track(YES);
        NSUserNotification* card = [[[NSUserNotification alloc] init] autorelease];
        card.identifier = visible.UUIDString;
        center->notifications = @[card];
        tick(center);
        assert([outcome(removed) isEqual:@"removed"]);
        assert(outcome(visible) == nil && dismissalWaits.count == 1);
        markDone(visible);
        tick(center);
        assert([outcome(visible) isEqual:@"clicked"]);
        assert(dismissalTimer == nil);
        reset();

        // Delivery grace is retained; missing confirmation eventually frees capacity.
        NSUUID* waiting = track(NO);
        NSUInteger before = center->reads;
        tick(center);
        assert(center->reads == before && outcome(waiting) == nil);
        dismissalWaits[waiting] = [NSDate dateWithTimeIntervalSinceNow:-3];
        tick(center);
        assert([outcome(waiting) isEqual:@"removed"]);
        assert(dismissalTimer == nil);
        reset();

        // The OS query can pump callbacks. Newly confirmed delivery is not compared
        // with a snapshot taken before that confirmation.
        NSUUID* old = track(YES);
        NSUUID* new = track(NO);
        center->notifications = @[];
        center->onRead = ^{
            unsigned char bytes[16];
            [new getUUIDBytes:bytes];
            rust_notification_delivered(bytes);
            markDone(old); // interaction beats disappearance in the same OS query
        };
        tick(center);
        assert([outcome(old) isEqual:@"clicked"]);
        assert(outcome(new) == nil && dismissalWaits.count == 1);
        center->onRead = nil;
        tick(center);
        assert([outcome(new) isEqual:@"removed"]);
        assert(dismissalTimer == nil);
        reset();

        // Completion before queued registration must not create an orphan timer.
        NSUUID* early = [NSUUID UUID];
        markDone(early);
        addDismissalWait(early);
        assert(dismissalWaits.count == 0 && dismissalTimer == nil);
        // A subsequent send starts and stops a fresh shared poll.
        NSUUID* next = track(YES);
        assert(dismissalTimer != nil);
        removeDismissalWait(next);
        removeDismissalWait(next); // queued cleanup after a poll is idempotent
        assert(dismissalWaits.count == 0 && dismissalTimer == nil);
        puts("shared dismissal polling: all checks passed");
    }
}
