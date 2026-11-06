// In-process Node-API bridge: drags files out of the window. Electron's
// webContents.startDrag runs the same AppKit session; this one differs in two
// ways.
//
// 1. The pasteboard carries the list of file URLs once more, as the "web URLs
//    with titles" entry. While a drag is over a Chromium view — our own
//    window, on the way to a sidebar folder — Chromium asks for the dragged
//    URL on every mouse move, and without that entry it reads every item on
//    the pasteboard to find it: several pasteboard round trips and two file
//    lookups per file. At 148 photos that is 20 ms a move, the moves queue up,
//    and the drag trails the pointer. With the entry it is one read.
// 2. Only the first item draws the icon. startDrag gives every item the same
//    image, and N copies stack.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

// The pasteboard type "WebURLsWithTitlesPboardType" as the UTI AppKit files it
// under; Chromium (ui/base/clipboard/clipboard_constants_mac.mm) reads it by
// this name. Its value is two arrays of equal length: URLs, then titles.
static NSString *const kWebURLsWithTitles = @"dyn.ah62d4rv4gu8zs3pcnzme2641rf4guzdmsv0gn64uqm10c6xenv61a3k";

// The first file: everything NSURL writes, and the URL list.
@interface AFFirstDraggedFile : NSObject <NSPasteboardWriting>
@property(nonatomic, strong) NSURL *url;
@property(nonatomic, strong) NSArray *urlsWithTitles;
@end
@implementation AFFirstDraggedFile
- (NSArray<NSPasteboardType> *)writableTypesForPasteboard:(NSPasteboard *)pasteboard {
  return [[self.url writableTypesForPasteboard:pasteboard] arrayByAddingObject:kWebURLsWithTitles];
}
- (NSPasteboardWritingOptions)writingOptionsForType:(NSPasteboardType)type pasteboard:(NSPasteboard *)pasteboard {
  if ([type isEqualToString:kWebURLsWithTitles]) return 0;
  return [self.url respondsToSelector:_cmd] ? [self.url writingOptionsForType:type pasteboard:pasteboard] : 0;
}
- (id)pasteboardPropertyListForType:(NSPasteboardType)type {
  if ([type isEqualToString:kWebURLsWithTitles]) return self.urlsWithTitles;
  return [self.url pasteboardPropertyListForType:type];
}
@end

@interface AFFileDragSource : NSObject <NSDraggingSource>
@end
@implementation AFFileDragSource
// As startDrag: other apps copy, our own window sees whatever it asks for.
- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return context == NSDraggingContextOutsideApplication ? NSDragOperationCopy : NSDragOperationEvery;
}
@end

static napi_value property(napi_env env, napi_value obj, const char *key) {
  napi_value value; napi_get_named_property(env, obj, key, &value); return value;
}
static double number(napi_env env, napi_value obj, const char *key) {
  double result = 0; napi_get_value_double(env, property(env, obj, key), &result);
  return std::isfinite(result) ? result : 0;
}
static napi_value argument(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr); return arg;
}

static NSArray<NSURL *> *fileURLs(napi_env env, napi_value arg) {
  napi_value list = property(env, arg, "files");
  uint32_t count = 0; napi_get_array_length(env, list, &count);
  NSMutableArray<NSURL *> *urls = [NSMutableArray arrayWithCapacity:count];
  for (uint32_t i = 0; i < count; i++) {
    napi_value item; napi_get_element(env, list, i, &item);
    size_t size = 0;
    if (napi_get_value_string_utf8(env, item, nullptr, 0, &size) != napi_ok || !size) continue;
    std::string path(size + 1, '\0');
    napi_get_value_string_utf8(env, item, path.data(), path.size(), &size);
    path.resize(size);
    NSString *string = [NSString stringWithUTF8String:path.c_str()];
    if (string) [urls addObject:[NSURL fileURLWithPath:string]];
  }
  return urls;
}

// What goes on the pasteboard, one writer per file.
static NSArray<id<NSPasteboardWriting>> *writers(NSArray<NSURL *> *urls) {
  NSMutableArray *strings = [NSMutableArray arrayWithCapacity:urls.count];
  NSMutableArray *titles = [NSMutableArray arrayWithCapacity:urls.count];
  for (NSURL *url in urls) { [strings addObject:url.absoluteString]; [titles addObject:@""]; }
  AFFirstDraggedFile *first = [AFFirstDraggedFile new];
  first.url = urls.firstObject;
  first.urlsWithTitles = @[strings, titles];
  NSMutableArray *result = [NSMutableArray arrayWithObject:first];
  for (NSUInteger i = 1; i < urls.count; i++) [result addObject:urls[i]];
  return result;
}

// start({ handle, files, icon, width, height }): begins the drag at the
// pointer. `icon` is PNG data, `width`/`height` its size in points.
static napi_value start(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value arg = argument(env, info);
    void *bytes = nullptr; size_t size = 0;
    if (napi_get_buffer_info(env, property(env, arg, "handle"), &bytes, &size) != napi_ok || size != sizeof(void *)) {
      napi_throw_error(env, nullptr, "Invalid native window handle"); return nullptr;
    }
    void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
    NSView *view = (__bridge NSView *)pointer;
    // The handle is supplied only by main, never by renderer IPC.
    if (!view || !view.window) { napi_throw_error(env, nullptr, "Native window is unavailable"); return nullptr; }
    NSArray<NSURL *> *urls = fileURLs(env, arg);
    if (!urls.count) { napi_throw_error(env, nullptr, "No files to drag"); return nullptr; }

    void *png = nullptr; size_t pngSize = 0;
    NSImage *icon = nil;
    if (napi_get_buffer_info(env, property(env, arg, "icon"), &png, &pngSize) == napi_ok && pngSize) {
      icon = [[NSImage alloc] initWithData:[NSData dataWithBytes:png length:pngSize]];
    }
    if (!icon) { napi_throw_error(env, nullptr, "Invalid drag icon"); return nullptr; }
    double width = number(env, arg, "width"), height = number(env, arg, "height");
    if (width > 0 && height > 0) icon.size = NSMakeSize(width, height);

    NSPoint inWindow = view.window.mouseLocationOutsideOfEventStream;
    NSPoint inView = [view convertPoint:inWindow fromView:nil];
    NSRect frame = [view backingAlignedRect:NSMakeRect(inView.x - icon.size.width / 2, inView.y - icon.size.height / 2,
                                                       icon.size.width, icon.size.height)
                                    options:NSAlignAllEdgesNearest];
    NSMutableArray<NSDraggingItem *> *items = [NSMutableArray arrayWithCapacity:urls.count];
    for (id<NSPasteboardWriting> writer in writers(urls)) {
      NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:writer];
      [item setDraggingFrame:frame contents:items.count ? nil : icon];
      [items addObject:item];
    }

    // The mouse-down that began this was the page's; AppKit needs an event of
    // its own to start from.
    NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                                        location:inWindow
                                   modifierFlags:0
                                       timestamp:NSApp.currentEvent.timestamp
                                    windowNumber:view.window.windowNumber
                                         context:nil
                                     eventNumber:0
                                      clickCount:1
                                        pressure:1.0];
    static AFFileDragSource *source;
    if (!source) source = [AFFileDragSource new];
    [view beginDraggingSessionWithItems:items event:event source:source];
    napi_value out; napi_get_boolean(env, true, &out); return out;
  }
}

// pasteboard({ files }): writes the same items to a pasteboard of its own and
// reads them back the ways a drop target does. For tests — a drag itself needs
// a held mouse button.
static napi_value pasteboard(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    NSArray<NSURL *> *urls = fileURLs(env, argument(env, info));
    NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
    [board clearContents];
    [board writeObjects:writers(urls)];
    // Chromium's first look, and its legacy spelling.
    NSArray *byUTI = [board propertyListForType:kWebURLsWithTitles];
    NSArray *byName = [board propertyListForType:@"WebURLsWithTitlesPboardType"];
    // Finder's and everyone else's: one file URL per item.
    NSArray<NSURL *> *read = [board readObjectsForClasses:@[NSURL.class]
                                                  options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    NSMutableArray<NSString *> *firstTypes = [NSMutableArray array];
    for (NSPasteboardType type in board.pasteboardItems.firstObject.types) [firstTypes addObject:type];
    NSMutableArray<NSString *> *secondTypes = [NSMutableArray array];
    if (board.pasteboardItems.count > 1) {
      for (NSPasteboardType type in board.pasteboardItems[1].types) [secondTypes addObject:type];
    }
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSURL *url in read) [paths addObject:url.path ?: @""];
    NSDictionary *result = @{
      @"items": @(board.pasteboardItems.count),
      @"files": paths,
      @"urlList": [byUTI isKindOfClass:NSArray.class] && byUTI.count == 2 ? byUTI[0] : @[],
      @"titles": [byUTI isKindOfClass:NSArray.class] && byUTI.count == 2 ? byUTI[1] : @[],
      @"sameByName": @([byUTI isEqual:byName]),
      @"firstTypes": firstTypes,
      @"secondTypes": secondTypes,
    };
    [board releaseGlobally];
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    napi_value out;
    napi_create_string_utf8(env, (const char *)json.bytes, json.length, &out);
    return out;
  }
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"pasteboard", nullptr, pasteboard, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
