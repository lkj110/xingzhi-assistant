import AppKit
import ApplicationServices

func emit(_ value: [String:Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject:value), let line = String(data:data,encoding:.utf8) else { return }
    print(line); fflush(stdout)
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let trusted = AXIsProcessTrusted()
emit(["type":"status","trusted":trusted])
guard trusted else { exit(2) }
let ownBundles = ["local.xingzhi.assistant", "com.github.Electron"]
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success ? value : nil
}
func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
    guard let raw = attribute(app,kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw,to:AXUIElement.self)
}
func metadata(_ front: NSRunningApplication, _ app: AXUIElement) -> [String:Any] {
    var result: [String:Any] = ["pid":front.processIdentifier,"app":front.localizedName ?? "其他应用","bundleId":front.bundleIdentifier ?? ""]
    if let window = focusedWindow(app) {
        if let title = attribute(window,kAXTitleAttribute) as? String { result["windowTitle"] = String(title.prefix(500)) }
        if let url = attribute(window,kAXDocumentAttribute) as? String, url.hasPrefix("https://") || url.hasPrefix("http://") { result["url"] = url }
    }
    return result
}
// Invoked only after a toolbar action. A custom-rendered editor may expose no
// AX text; its normal Copy command is the interoperability boundary.
func copySelection() {
    func finish(_ text: String? = nil, _ error: String = "无法读取选区，请重新选择；也可复制后粘贴到小窗") -> Never {
        emit(text.map { ["type":"copy_result","text":$0] } ?? ["type":"copy_result","error":error]); exit(0)
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 4096, let request = (try? JSONSerialization.jsonObject(with:input)) as? [String:Any],
          let pid = request["pid"] as? Int32, let bundle = request["bundleId"] as? String,
          let target = NSRunningApplication(processIdentifier:pid), target.bundleIdentifier == bundle,
          !ownBundles.contains(bundle), let front = NSWorkspace.shared.frontmostApplication,
          front.processIdentifier == pid || ownBundles.contains(front.bundleIdentifier ?? "") else { finish() }
    let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app,0.3)
    func validTarget() -> Bool {
        guard !target.isTerminated, let window = focusedWindow(app),
              String((attribute(window,kAXTitleAttribute) as? String ?? "").prefix(500)) == (request["windowTitle"] as? String ?? "") else { return false }
        if let raw = attribute(app,kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
            let element = unsafeBitCast(raw,to:AXUIElement.self)
            if (attribute(element,kAXSubroleAttribute) as? String ?? "").lowercased().contains("secure") { return false }
        }
        return true
    }
    guard validTarget() else { finish() }
    let board = NSPasteboard.general, before = board.changeCount
    var originals: [NSPasteboardItem] = [], total = 0
    for item in board.pasteboardItems ?? [] {
        let saved = NSPasteboardItem()
        for type in item.types {
            guard let data = item.data(forType:type) else { finish(nil,"原剪贴板无法完整保留，请手动复制选区后粘贴") }
            total += data.count
            guard total <= 10_000_000 else { finish(nil,"剪贴板内容较大，请手动复制选区后粘贴") }
            saved.setData(data,forType:type)
        }
        originals.append(saved)
    }
    guard board.changeCount == before else { finish(nil,"剪贴板已变化，请重新选择") }
    target.activate(options:[])
    let deadline = Date().addingTimeInterval(2)
    var sent = false
    let timer = Timer(timeInterval:0.05,repeats:true) { timer in
        guard Date() < deadline else { timer.invalidate(); finish() }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            if sent { timer.invalidate(); finish(nil,"窗口已切换，请重新选择") }; return
        }
        if !sent {
            guard validTarget(), board.changeCount == before,
                  let down = CGEvent(keyboardEventSource:nil,virtualKey:8,keyDown:true),
                  let up = CGEvent(keyboardEventSource:nil,virtualKey:8,keyDown:false) else { timer.invalidate(); finish() }
            down.flags = .maskCommand; up.flags = .maskCommand
            sent = true; down.post(tap:.cghidEventTap); up.post(tap:.cghidEventTap); return
        }
        guard board.changeCount != before else { return }
        timer.invalidate()
        let copied = board.changeCount
        // Never return the clipboard's previous text when Copy was unavailable.
        let text = board.string(forType:.string)?.trimmingCharacters(in:.whitespacesAndNewlines)
        if board.changeCount == copied {
            board.clearContents()
            if !originals.isEmpty { board.writeObjects(originals) }
        } else { finish(nil,"剪贴板已变化，请重新选择") }
        guard let text, text.count >= 2, text.count <= 20000 else { finish() }
        finish(text)
    }
    RunLoop.main.add(timer,forMode:.common)
    application.run()
}
if CommandLine.arguments.contains("--copy-selection") { copySelection(); exit(0) }
var lastText = ""
var lastPID: pid_t = 0
var pending: Timer?
var pendingElement: AXUIElement?
var observer: AXObserver?
var observedApp: AXUIElement?
var observedElement: AXUIElement?
var observedPID: pid_t = 0
var pendingGesture = false
var dragStart: NSPoint?
var dragPID: pid_t = 0
func diagnostic(_ stage: String) { emit(["type":"diagnostic","stage":stage]) }
func cancelPendingSelection() {
    pending?.invalidate(); pending = nil; pendingElement = nil; pendingGesture = false
}
func dismissTransient(_ reason: String) {
    cancelPendingSelection()
    emit(["type":"dismiss","reason":reason])
}
func selection(_ selectedElement: AXUIElement? = nil, gesture: Bool = false) {
    diagnostic("read_started")
    guard let front = NSWorkspace.shared.frontmostApplication else { lastText = ""; diagnostic("focus_unavailable"); return }
    let bundle = front.bundleIdentifier ?? ""
    if ownBundles.contains(bundle) { diagnostic("own_app"); return }
    let app = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(app,0.4)
    func candidate() {
        guard gesture, let window = focusedWindow(app) else { return }
        // Ignore title-bar drags and window controls. AX uses top-left display coordinates.
        if let p = attribute(window,kAXPositionAttribute), let s = attribute(window,kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() {
            var origin = CGPoint.zero, size = CGSize.zero
            AXValueGetValue(unsafeBitCast(p,to:AXValue.self),.cgPoint,&origin); AXValueGetValue(unsafeBitCast(s,to:AXValue.self),.cgSize,&size)
            let mouse = NSEvent.mouseLocation, primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
            let point = CGPoint(x:mouse.x,y:primaryTop-mouse.y)
            guard CGRect(x:origin.x+5,y:origin.y+45,width:max(0,size.width-20),height:max(0,size.height-60)).contains(point) else { return }
        }
        var payload = metadata(front,app); payload["type"] = "candidate"; diagnostic("copy_candidate"); emit(payload)
    }
    let element: AXUIElement
    if let selectedElement {
        var pid: pid_t = 0
        guard AXUIElementGetPid(selectedElement,&pid) == .success, pid == front.processIdentifier else { diagnostic("focus_changed"); return }
        element = selectedElement
    } else {
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(app,kAXFocusedUIElementAttribute as CFString,&raw)
        guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { diagnostic("focus_unavailable"); candidate(); return }
        element = unsafeBitCast(raw,to:AXUIElement.self)
    }
    AXUIElementSetMessagingTimeout(element,0.4)
    var subrole: CFTypeRef?
    _ = AXUIElementCopyAttributeValue(element,kAXSubroleAttribute as CFString,&subrole)
    if let subrole = subrole as? String, subrole.lowercased().contains("secure") { lastText = ""; return }
    var selected = attribute(element,kAXSelectedTextAttribute) as? String
    if selected == nil, let rawRange = attribute(element,kAXSelectedTextRangeAttribute), CFGetTypeID(rawRange) == AXValueGetTypeID() {
        var range = CFRange()
        if AXValueGetValue(unsafeBitCast(rawRange,to:AXValue.self),.cfRange,&range) {
            if range.length == 0 { lastText = ""; diagnostic("selection_empty"); dismissTransient("selection_cleared"); return }
            if range.location >= 0, range.length <= 20000 {
                var raw: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(element,kAXStringForRangeParameterizedAttribute as CFString,rawRange,&raw) == .success { selected = raw as? String }
                if selected == nil, let value = attribute(element,kAXValueAttribute) as? String {
                    let full = value as NSString
                    if range.location <= full.length, range.length <= full.length-range.location { selected = full.substring(with:NSRange(location:range.location,length:range.length)) }
                }
            }
        }
    }
    guard let selected else { lastText = ""; diagnostic("selection_unavailable"); candidate(); return }
    let content = selected.trimmingCharacters(in:.whitespacesAndNewlines)
    guard content.count >= 2, content.count <= 20000 else { lastText = ""; diagnostic("selection_empty"); dismissTransient("selection_cleared"); return }
    // AX notification bursts are duplicates; a fresh selection gesture is not.
    guard gesture || content != lastText || lastPID != front.processIdentifier else { return }
    lastText = content; lastPID = front.processIdentifier
    diagnostic("selection_read")
    var payload: [String:Any] = ["type":"selection","text":content,"app":front.localizedName ?? "其他应用","bundleId":bundle]
    var windowRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element,kAXWindowAttribute as CFString,&windowRef) != .success { _ = AXUIElementCopyAttributeValue(app,kAXFocusedWindowAttribute as CFString,&windowRef) }
    if let windowRef, CFGetTypeID(windowRef) == AXUIElementGetTypeID() {
        let window = unsafeBitCast(windowRef,to:AXUIElement.self)
        var title: CFTypeRef?; _ = AXUIElementCopyAttributeValue(window,kAXTitleAttribute as CFString,&title)
        if let title = title as? String { payload["windowTitle"] = String(title.prefix(500)) }
        var document: CFTypeRef?; _ = AXUIElementCopyAttributeValue(window,kAXDocumentAttribute as CFString,&document)
        if let address = document as? String, address.hasPrefix("https://") || address.hasPrefix("http://") { payload["url"] = address }
    }
    emit(payload)
}
func scheduleSelection(_ element: AXUIElement? = nil, gesture: Bool = false) {
    // A run-loop timer remains deliverable during AppKit tracking modes. Keep
    // one pending read instead of indefinitely postponing it on noisy AX events.
    if let element { pendingElement = element }
    pendingGesture = pendingGesture || gesture
    guard pending == nil else { return }
    let timer = Timer(timeInterval:0.18,repeats:false) { _ in
        let target = pendingElement
        let gesture = pendingGesture
        pending = nil; pendingElement = nil; pendingGesture = false
        if NSEvent.pressedMouseButtons & 1 != 0 { scheduleSelection(target,gesture:gesture); return }
        selection(target,gesture:gesture)
    }
    pending = timer
    RunLoop.main.add(timer,forMode:.common)
}
func observeFocusedElement() {
    guard let observer, let app = observedApp else { return }
    if let element = observedElement { AXObserverRemoveNotification(observer,element,kAXSelectedTextChangedNotification as CFString) }
    observedElement = nil
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app,kAXFocusedUIElementAttribute as CFString,&raw) == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return }
    let element = unsafeBitCast(raw,to:AXUIElement.self)
    observedElement = element
    _ = AXObserverAddNotification(observer,element,kAXSelectedTextChangedNotification as CFString,nil)
}
func observeFrontApplication() {
    guard let front = NSWorkspace.shared.frontmostApplication else { return }
    if observedPID == front.processIdentifier { return }
    if let previous = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(previous),.commonModes) }
    observer = nil; observedApp = nil; observedElement = nil; observedPID = front.processIdentifier
    lastText = ""
    if ["local.xingzhi.assistant","com.github.Electron"].contains(front.bundleIdentifier ?? "") { return }
    var next: AXObserver?
    let result = AXObserverCreate(front.processIdentifier,{ _,element,notification,_ in
        if notification as String == kAXFocusedUIElementChangedNotification { observeFocusedElement(); return }
        diagnostic("selection_changed")
        scheduleSelection(element)
    },&next)
    guard result == .success, let next else { return }
    observer = next
    let app = AXUIElementCreateApplication(front.processIdentifier); observedApp = app
    AXUIElementSetMessagingTimeout(app,0.4)
    CFRunLoopAddSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(next),.commonModes)
    _ = AXObserverAddNotification(next,app,kAXFocusedUIElementChangedNotification as CFString,nil)
    observeFocusedElement()
}
// Selection notifications also cover apps whose gestures are not delivered to
// NSEvent's global monitor. Neither path reads typed keys or the clipboard.
let activation = NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { _ in
    cancelPendingSelection()
    if let front = NSWorkspace.shared.frontmostApplication, !ownBundles.contains(front.bundleIdentifier ?? "") { dismissTransient("app_changed") }
    observeFrontApplication()
}
observeFrontApplication()
let monitor = NSEvent.addGlobalMonitorForEvents(matching:[.leftMouseDown,.rightMouseDown,.otherMouseDown,.leftMouseUp,.keyDown,.keyUp,.scrollWheel]) { event in
    if event.type == .scrollWheel { dismissTransient("scroll"); return }
    if event.type == .keyDown {
        // Only classify the gesture; no typed content is read or emitted.
        let selectionKey = event.modifierFlags.contains(.shift) && [123,124,125,126,115,119].contains(event.keyCode) || event.modifierFlags.contains(.command) && event.keyCode == 0
        if !selectionKey, !ownBundles.contains(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "") { dismissTransient("keyboard") }
        return
    }
    if [.leftMouseDown,.rightMouseDown,.otherMouseDown].contains(event.type) {
        cancelPendingSelection()
        dragStart = NSEvent.mouseLocation; dragPID = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        let point = NSEvent.mouseLocation
        emit(["type":"dismiss","x":point.x,"y":(NSScreen.screens.first?.frame.maxY ?? 0)-point.y])
        return
    }
    if event.type == .keyUp && !(event.modifierFlags.contains(.shift) && [123,124,125,126,115,119].contains(event.keyCode) || event.modifierFlags.contains(.command) && event.keyCode == 0) { return }
    let mouse = NSEvent.mouseLocation
    let dragged = dragStart.map { hypot(mouse.x-$0.x,mouse.y-$0.y) >= 6 } ?? false
    let gesture = event.type == .keyUp || (dragPID == NSWorkspace.shared.frontmostApplication?.processIdentifier && (dragged || event.clickCount >= 2))
    dragStart = nil
    diagnostic("gesture_received")
    observeFrontApplication()
    scheduleSelection(gesture:gesture)
}
guard monitor != nil else { emit(["type":"error","message":"无法监听鼠标选择事件"]); exit(3) }
application.run()
