// In-process Node-API bridge: AVPlayer draws the original into the Electron
// window. No encoded intermediate, frame copies over IPC, or extra process.
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#include <node_api.h>
#include <cmath>
#include <cstring>
#include <string>

@interface AFVideoView : NSView
@end
@implementation AFVideoView
- (BOOL)isFlipped { return YES; }
// The React surface owns clicks, shortcuts and transport controls.
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end

@interface AFVideoSession : NSObject
@property(nonatomic, strong) AFVideoView *view;
@property(nonatomic, strong) AVPlayer *player;
@property(nonatomic, strong) AVPlayerLayer *playerLayer;
@property(nonatomic) BOOL seeking;
@property(nonatomic) NSUInteger seekSerial;
@end
@implementation AFVideoSession
@end

static NSMutableDictionary<NSNumber *, AFVideoSession *> *sessions;
static uint32_t nextID = 0;

static napi_value property(napi_env env, napi_value obj, const char *key) {
  napi_value value; napi_get_named_property(env, obj, key, &value); return value;
}
static double number(napi_env env, napi_value obj, const char *key) {
  double result = 0; napi_get_value_double(env, property(env, obj, key), &result);
  return std::isfinite(result) ? result : 0;
}
static std::string string(napi_env env, napi_value obj, const char *key) {
  napi_value value = property(env, obj, key); size_t size = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &size);
  std::string result(size + 1, '\0');
  napi_get_value_string_utf8(env, value, result.data(), result.size(), &size);
  result.resize(size); return result;
}
static void setNumber(napi_env env, napi_value obj, const char *key, double n) {
  napi_value value; napi_create_double(env, std::isfinite(n) ? n : 0, &value);
  napi_set_named_property(env, obj, key, value);
}
static void setBool(napi_env env, napi_value obj, const char *key, bool b) {
  napi_value value; napi_get_boolean(env, b, &value); napi_set_named_property(env, obj, key, value);
}
static napi_value argument(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr); return arg;
}
static napi_value empty(napi_env env) { napi_value v; napi_get_null(env, &v); return v; }

static void layout(napi_env env, AFVideoSession *session, napi_value rect) {
  NSView *parent = session.view.superview;
  double x = number(env, rect, "x"), y = number(env, rect, "y");
  double w = fmax(0, number(env, rect, "width")), h = fmax(0, number(env, rect, "height"));
  NSRect frame = NSMakeRect(x, parent.isFlipped ? y : parent.bounds.size.height - y - h, w, h);
  [CATransaction begin]; [CATransaction setDisableActions:YES];
  session.view.frame = frame;
  session.playerLayer.frame = session.view.bounds;
  [CATransaction commit];
}
static void stop(AFVideoSession *session) {
  [session.player pause]; [session.player replaceCurrentItemWithPlayerItem:nil];
  session.playerLayer.player = nil; [session.view removeFromSuperview];
}
static void cleanup(void *) {
  for (AFVideoSession *session in sessions.allValues) stop(session);
  [sessions removeAllObjects];
}

static napi_value openPlayer(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value arg = argument(env, info);
    void *bytes = nullptr; size_t size = 0;
    if (napi_get_buffer_info(env, property(env, arg, "handle"), &bytes, &size) != napi_ok || size != sizeof(void *)) {
      napi_throw_error(env, nullptr, "Invalid native window handle"); return nullptr;
    }
    void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
    NSView *parent = (__bridge NSView *)pointer;
    // The handle is supplied only by main, never by renderer IPC.
    if (!parent || !parent.window) { napi_throw_error(env, nullptr, "Native window is unavailable"); return nullptr; }
    NSString *path = [NSString stringWithUTF8String:string(env, arg, "path").c_str()];
    AFVideoSession *session = [AFVideoSession new];
    session.player = [AVPlayer playerWithURL:[NSURL fileURLWithPath:path]];
    session.view = [[AFVideoView alloc] initWithFrame:NSZeroRect];
    // Between the page's bounds updates (a live resize), keep the margins the
    // lightbox gives the surface: fixed to every edge of the window.
    session.view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    session.view.wantsLayer = YES;
    session.playerLayer = [AVPlayerLayer playerLayerWithPlayer:session.player];
    session.playerLayer.videoGravity = AVLayerVideoGravityResizeAspect;
    session.playerLayer.backgroundColor = NSColor.blackColor.CGColor;
    session.playerLayer.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    session.playerLayer.actions = @{ @"bounds": NSNull.null, @"position": NSNull.null };
    [session.view.layer addSublayer:session.playerLayer];
    [parent addSubview:session.view positioned:NSWindowAbove relativeTo:nil];
    layout(env, session, property(env, arg, "bounds"));
    uint32_t identifier = ++nextID;
    sessions[@(identifier)] = session;
    [session.player play];
    napi_value out; napi_create_uint32(env, identifier, &out); return out;
  }
}
static napi_value state(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value arg = argument(env, info);
    AFVideoSession *s = sessions[@((uint32_t)number(env, arg, "id"))];
    if (!s) return empty(env);
    AVPlayerItem *item = s.player.currentItem;
    napi_value out; napi_create_object(env, &out);
    setNumber(env, out, "time", CMTimeGetSeconds(s.player.currentTime));
    setNumber(env, out, "duration", CMTimeGetSeconds(item.duration));
    setNumber(env, out, "width", item.presentationSize.width);
    setNumber(env, out, "height", item.presentationSize.height);
    setBool(env, out, "playing", s.player.rate != 0);
    setBool(env, out, "muted", s.player.muted);
    setBool(env, out, "ready", s.playerLayer.readyForDisplay);
    setBool(env, out, "failed", item.status == AVPlayerItemStatusFailed);
    setBool(env, out, "visible", !s.view.hidden);
    setBool(env, out, "seeking", s.seeking);
    // Where the picture is, in the page's terms (points from the top left).
    NSView *parent = s.view.superview;
    NSRect frame = s.view.frame;
    napi_value rect; napi_create_object(env, &rect);
    setNumber(env, rect, "x", frame.origin.x);
    setNumber(env, rect, "y", parent.isFlipped ? frame.origin.y : parent.bounds.size.height - NSMaxY(frame));
    setNumber(env, rect, "width", frame.size.width);
    setNumber(env, rect, "height", frame.size.height);
    napi_set_named_property(env, out, "frame", rect);
    double duration = CMTimeGetSeconds(item.duration), time = CMTimeGetSeconds(s.player.currentTime);
    setBool(env, out, "ended", std::isfinite(duration) && duration > 0 && time >= duration - 0.05 && s.player.rate == 0);
    return out;
  }
}
static napi_value command(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value arg = argument(env, info);
    AFVideoSession *s = sessions[@((uint32_t)number(env, arg, "id"))];
    if (!s) return empty(env);
    std::string action = string(env, arg, "action");
    double value = number(env, arg, "value");
    if (action == "play") {
      double duration = CMTimeGetSeconds(s.player.currentItem.duration);
      if (std::isfinite(duration) && CMTimeGetSeconds(s.player.currentTime) >= duration - 0.05)
        [s.player seekToTime:kCMTimeZero];
      [s.player play];
    } else if (action == "pause") [s.player pause];
    else if (action == "seek") {
      double duration = CMTimeGetSeconds(s.player.currentItem.duration);
      double target = fmax(0, value);
      if (std::isfinite(duration)) target = fmin(target, duration);
      s.seeking = YES;
      NSUInteger serial = ++s.seekSerial;
      [s.player seekToTime:CMTimeMakeWithSeconds(target, 600) toleranceBefore:kCMTimeZero toleranceAfter:kCMTimeZero completionHandler:^(BOOL finished) {
        dispatch_async(dispatch_get_main_queue(), ^{ if (s.seekSerial == serial) s.seeking = NO; });
      }];
    }
    else if (action == "mute") s.player.muted = value != 0;
    else if (action == "bounds") layout(env, s, property(env, arg, "bounds"));
    else if (action == "visible") s.view.hidden = value == 0;
    return empty(env);
  }
}
static napi_value closePlayer(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    uint32_t identifier = (uint32_t)number(env, argument(env, info), "id");
    AFVideoSession *s = sessions[@(identifier)]; if (s) stop(s);
    [sessions removeObjectForKey:@(identifier)]; return empty(env);
  }
}
static napi_value init(napi_env env, napi_value exports) {
  sessions = [NSMutableDictionary new];
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  napi_property_descriptor methods[] = {
    {"open", nullptr, openPlayer, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"state", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"command", nullptr, command, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, closePlayer, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
