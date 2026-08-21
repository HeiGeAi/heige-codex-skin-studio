import AppKit
import Foundation
import QuartzCore

enum ProductID: String, CaseIterable {
    case codex = "codex"
    case workbuddy = "workbuddy"
}

struct ProductDefinition {
    let id: ProductID
    let title: String
    let badge: String
    let actionTitle: String
    let note: String
    let bundleIdentifier: String

    static let all: [ProductDefinition] = [
        ProductDefinition(
            id: .codex,
            title: "Codex",
            badge: "会话皮肤",
            actionTitle: "打开 Codex 皮肤",
            note: "打开最近皮肤，关闭只影响当前会话。",
            bundleIdentifier: "com.openai.codex"
        ),
        ProductDefinition(
            id: .workbuddy,
            title: "WorkBuddy",
            badge: "单次恢复",
            actionTitle: "打开 WorkBuddy 皮肤",
            note: "打开最近皮肤，关闭只影响当前会话。",
            bundleIdentifier: "com.workbuddy.workbuddy"
        ),
    ]
}

struct LauncherProductState: Decodable {
    let schemaVersion: Int
    let product: String
    let productName: String
    let appInstalled: Bool
    let appPath: String?
    let themeId: String
    let themeName: String
    let mode: String

    func validated(for definition: ProductDefinition) throws -> LauncherProductState {
        guard schemaVersion == 1 else { throw LauncherError.invalidState("状态版本不受支持") }
        guard product == definition.id.rawValue else { throw LauncherError.invalidState("状态产品不匹配") }
        guard !productName.isEmpty, !themeId.isEmpty, !themeName.isEmpty else {
            throw LauncherError.invalidState("状态字段不完整")
        }
        let expectedMode = definition.id == .codex ? "session" : "one-shot"
        guard mode == expectedMode else { throw LauncherError.invalidState("状态模式不匹配") }
        if appInstalled {
            guard let appPath, appPath.hasPrefix("/"), appPath.hasSuffix(".app") else {
                throw LauncherError.invalidState("APP 路径无效")
            }
        } else if appPath != nil {
            throw LauncherError.invalidState("未安装产品不应返回 APP 路径")
        }
        return self
    }
}

enum LauncherError: LocalizedError {
    case invalidBundle(String)
    case invalidState(String)
    case commandFailed(String)
    case outputTooLarge
    case activationFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidBundle(let message), .invalidState(let message),
             .commandFailed(let message), .activationFailed(let message):
            return message
        case .outputTooLarge:
            return "启动器命令输出超过安全上限"
        }
    }
}

struct ProcessOutput {
    let status: Int32
    let stdout: Data
    let stderr: Data
}

final class ResultBox {
    private let lock = NSLock()
    private var storage: Result<Data, Error>?

    func store(_ value: Result<Data, Error>) {
        lock.lock()
        storage = value
        lock.unlock()
    }

    func load() -> Result<Data, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

enum ProcessRunner {
    private static let outputLimit = 256 * 1024

    private static func readBounded(_ handle: FileHandle) -> Result<Data, Error> {
        var result = Data()
        var exceeded = false
        do {
            while let chunk = try handle.read(upToCount: 4096), !chunk.isEmpty {
                if result.count + chunk.count <= outputLimit {
                    result.append(chunk)
                } else {
                    exceeded = true
                }
            }
            return exceeded ? .failure(LauncherError.outputTooLarge) : .success(result)
        } catch {
            return .failure(error)
        }
    }

    static func run(executable: URL, arguments: [String], currentDirectory: URL) throws -> ProcessOutput {
        let process = Process()
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = currentDirectory
        process.standardOutput = standardOutput
        process.standardError = standardError

        try process.run()

        let group = DispatchGroup()
        let outputBox = ResultBox()
        let errorBox = ResultBox()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            outputBox.store(readBounded(standardOutput.fileHandleForReading))
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errorBox.store(readBounded(standardError.fileHandleForReading))
            group.leave()
        }

        process.waitUntilExit()
        group.wait()
        let stdout = try outputBox.load()?.get() ?? Data()
        let stderr = try errorBox.load()?.get() ?? Data()
        return ProcessOutput(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}

class AppearanceSurfaceView: NSView {
    private let semanticBackgroundColor: NSColor?
    private let semanticBorderColor: NSColor?

    init(
        backgroundColor: NSColor? = nil,
        borderColor: NSColor? = nil,
        cornerRadius: CGFloat = 0,
        borderWidth: CGFloat = 0
    ) {
        semanticBackgroundColor = backgroundColor
        semanticBorderColor = borderColor
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = cornerRadius
        layer?.borderWidth = borderWidth
        applyAppearanceColors()
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyAppearanceColors()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyAppearanceColors()
    }

    private func applyAppearanceColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = semanticBackgroundColor?.cgColor
            layer?.borderColor = semanticBorderColor?.cgColor
        }
    }
}

final class LauncherBackdropView: AppearanceSurfaceView {
    private let cyan = NSColor(red: 0.22, green: 0.84, blue: 0.81, alpha: 1)
    private let pink = NSColor(red: 0.96, green: 0.55, blue: 0.77, alpha: 1)

    init() {
        super.init(backgroundColor: .windowBackgroundColor)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let accentRect = NSRect(x: 0, y: bounds.height - 3, width: bounds.width, height: 3)
        NSGradient(starting: cyan, ending: pink)?.draw(in: accentRect, angle: 0)

        let cyanGlow = NSBezierPath(ovalIn: NSRect(
            x: -150,
            y: bounds.height - 250,
            width: 470,
            height: 300
        ))
        NSGradient(
            starting: cyan.withAlphaComponent(0.11),
            ending: .clear
        )?.draw(in: cyanGlow, relativeCenterPosition: .zero)

        let pinkGlow = NSBezierPath(ovalIn: NSRect(
            x: bounds.width - 300,
            y: bounds.height - 210,
            width: 420,
            height: 250
        ))
        NSGradient(
            starting: pink.withAlphaComponent(0.08),
            ending: .clear
        )?.draw(in: pinkGlow, relativeCenterPosition: .zero)
    }
}

final class StatusPillView: NSView {
    private let label = NSTextField(labelWithString: "")
    private var tintColor: NSColor

    init(text: String, tint: NSColor) {
        tintColor = tint
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 0.5
        label.stringValue = text
        label.font = .systemFont(ofSize: 10, weight: .medium)
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            heightAnchor.constraint(equalToConstant: 22),
        ])
        applyColors()
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyColors()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
    }

    func update(text: String, tint: NSColor) {
        label.stringValue = text
        tintColor = tint
        applyColors()
    }

    private func applyColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            label.textColor = tintColor
            layer?.backgroundColor = tintColor.withAlphaComponent(0.12).cgColor
            layer?.borderColor = tintColor.withAlphaComponent(0.28).cgColor
        }
    }
}

final class BrandLogoView: AppearanceSurfaceView {
    private let icon = NSImageView()

    init() {
        super.init(
            borderColor: .systemTeal.withAlphaComponent(0.6),
            cornerRadius: 17,
            borderWidth: 1
        )
        layer?.masksToBounds = true

        if let iconURL = Bundle.main.url(forResource: "LauncherLogo", withExtension: "png") {
            icon.image = NSImage(contentsOf: iconURL)
        } else {
            icon.image = NSApp.applicationIconImage
        }
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.imageAlignment = .alignCenter
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.setAccessibilityLabel("初音未来启动器内置 Logo")
        addSubview(icon)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor),
            icon.trailingAnchor.constraint(equalTo: trailingAnchor),
            icon.topAnchor.constraint(equalTo: topAnchor),
            icon.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }
}

final class ProductCardView: AppearanceSurfaceView {
    let definition: ProductDefinition
    var onAction: ((ProductDefinition) -> Void)?
    var onClose: ((ProductDefinition) -> Void)?

    private let accentColor: NSColor
    private let appIcon = NSImageView()
    private let statusPill: StatusPillView
    private let themeLabel = NSTextField(labelWithString: "正在读取最近皮肤…")
    private let actionButton = NSButton(title: "读取中…", target: nil, action: nil)
    private let closeButton = NSButton(title: "关闭皮肤", target: nil, action: nil)
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private var state: LauncherProductState?

    init(definition: ProductDefinition) {
        self.definition = definition
        accentColor = definition.id == .codex
            ? NSColor(red: 0.12, green: 0.76, blue: 0.72, alpha: 1)
            : NSColor(red: 0.46, green: 0.42, blue: 0.98, alpha: 1)
        statusPill = StatusPillView(
            text: "读取中",
            tint: definition.id == .codex
                ? NSColor(red: 0.12, green: 0.76, blue: 0.72, alpha: 1)
                : NSColor(red: 0.46, green: 0.42, blue: 0.98, alpha: 1)
        )
        super.init(
            backgroundColor: .controlBackgroundColor.withAlphaComponent(0.9),
            borderColor: accentColor.withAlphaComponent(0.32),
            cornerRadius: 18,
            borderWidth: 1
        )

        let appIconSurface = AppearanceSurfaceView(
            backgroundColor: .windowBackgroundColor,
            borderColor: accentColor.withAlphaComponent(0.25),
            cornerRadius: 14,
            borderWidth: 0.5
        )
        appIconSurface.translatesAutoresizingMaskIntoConstraints = false
        appIcon.imageScaling = .scaleProportionallyUpOrDown
        appIcon.imageAlignment = .alignCenter
        appIcon.contentTintColor = accentColor
        appIcon.translatesAutoresizingMaskIntoConstraints = false
        appIcon.setAccessibilityLabel("\(definition.title) 应用图标")
        appIconSurface.addSubview(appIcon)
        NSLayoutConstraint.activate([
            appIconSurface.widthAnchor.constraint(equalToConstant: 52),
            appIconSurface.heightAnchor.constraint(equalToConstant: 52),
            appIcon.leadingAnchor.constraint(equalTo: appIconSurface.leadingAnchor, constant: 4),
            appIcon.trailingAnchor.constraint(equalTo: appIconSurface.trailingAnchor, constant: -4),
            appIcon.topAnchor.constraint(equalTo: appIconSurface.topAnchor, constant: 4),
            appIcon.bottomAnchor.constraint(equalTo: appIconSurface.bottomAnchor, constant: -4),
        ])

        let title = NSTextField(labelWithString: definition.title)
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.textColor = .labelColor
        let target = NSTextField(labelWithString: definition.id == .codex ? "CODING DESKTOP" : "AI WORKSPACE")
        target.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
        target.textColor = accentColor
        let productText = NSStackView(views: [target, title])
        productText.orientation = .vertical
        productText.alignment = .leading
        productText.spacing = 3
        let identity = NSStackView(views: [appIconSurface, productText])
        identity.orientation = .horizontal
        identity.alignment = .centerY
        identity.spacing = 12

        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let header = NSStackView(views: [identity, headerSpacer, statusPill])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.distribution = .fill

        let themeIcon = NSImageView()
        themeIcon.image = NSImage(
            systemSymbolName: "paintpalette.fill",
            accessibilityDescription: "最近皮肤"
        )
        themeIcon.contentTintColor = accentColor
        themeIcon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            themeIcon.widthAnchor.constraint(equalToConstant: 24),
            themeIcon.heightAnchor.constraint(equalToConstant: 24),
        ])
        let recentTitle = NSTextField(labelWithString: "最近使用")
        recentTitle.font = .systemFont(ofSize: 10, weight: .medium)
        recentTitle.textColor = .secondaryLabelColor
        themeLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        themeLabel.textColor = .labelColor
        themeLabel.lineBreakMode = .byTruncatingTail
        let recentContent = NSStackView(views: [recentTitle, themeLabel])
        recentContent.orientation = .vertical
        recentContent.alignment = .leading
        recentContent.spacing = 3
        let recentRow = NSStackView(views: [themeIcon, recentContent])
        recentRow.orientation = .horizontal
        recentRow.alignment = .centerY
        recentRow.spacing = 10
        recentRow.translatesAutoresizingMaskIntoConstraints = false
        let recent = AppearanceSurfaceView(
            backgroundColor: .windowBackgroundColor,
            borderColor: accentColor.withAlphaComponent(0.14),
            cornerRadius: 12,
            borderWidth: 0.5
        )
        recent.addSubview(recentRow)
        NSLayoutConstraint.activate([
            recentRow.leadingAnchor.constraint(equalTo: recent.leadingAnchor, constant: 13),
            recentRow.trailingAnchor.constraint(equalTo: recent.trailingAnchor, constant: -13),
            recentRow.topAnchor.constraint(equalTo: recent.topAnchor, constant: 11),
            recentRow.bottomAnchor.constraint(equalTo: recent.bottomAnchor, constant: -11),
        ])

        actionButton.target = self
        actionButton.action = #selector(actionClicked)
        actionButton.bezelStyle = .rounded
        actionButton.controlSize = .large
        actionButton.font = .systemFont(ofSize: 13, weight: .semibold)
        actionButton.bezelColor = accentColor
        actionButton.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)
        actionButton.imagePosition = .imageLeading
        actionButton.isBordered = false
        actionButton.wantsLayer = true
        actionButton.layer?.cornerRadius = 8
        actionButton.layer?.backgroundColor = accentColor.cgColor
        actionButton.contentTintColor = .white
        actionButton.translatesAutoresizingMaskIntoConstraints = false
        actionButton.heightAnchor.constraint(equalToConstant: 34).isActive = true

        closeButton.target = self
        closeButton.action = #selector(closeClicked)
        closeButton.bezelStyle = .rounded
        closeButton.controlSize = .large
        closeButton.font = .systemFont(ofSize: 12, weight: .medium)
        closeButton.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: nil)
        closeButton.imagePosition = .imageLeading
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.widthAnchor.constraint(equalToConstant: 108).isActive = true
        closeButton.heightAnchor.constraint(equalToConstant: 34).isActive = true

        let actionRow = NSStackView(views: [actionButton, closeButton])
        actionRow.orientation = .horizontal
        actionRow.alignment = .centerY
        actionRow.distribution = .fill
        actionRow.spacing = 8
        setControlsEnabled(false)

        let note = NSTextField(wrappingLabelWithString: definition.note)
        note.font = .systemFont(ofSize: 10.5)
        note.textColor = .secondaryLabelColor
        errorLabel.font = .systemFont(ofSize: 10, weight: .medium)
        errorLabel.textColor = .systemRed
        errorLabel.maximumNumberOfLines = 2
        errorLabel.isHidden = true

        let cardSpacer = NSView()
        cardSpacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        let stack = NSStackView(views: [header, recent, actionRow, cardSpacer, note, errorLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            recent.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actionRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            widthAnchor.constraint(equalToConstant: 351),
            heightAnchor.constraint(equalToConstant: 286),
        ])
        loadApplicationIcon()
    }

    required init?(coder: NSCoder) { nil }

    @objc private func actionClicked() {
        onAction?(definition)
    }

    @objc private func closeClicked() {
        onClose?(definition)
    }

    func showReady(_ newState: LauncherProductState) {
        state = newState
        statusPill.update(
            text: newState.appInstalled ? definition.badge : "未安装",
            tint: newState.appInstalled ? accentColor : .secondaryLabelColor
        )
        themeLabel.stringValue = newState.themeName
        actionButton.title = definition.actionTitle
        setControlsEnabled(newState.appInstalled)
        errorLabel.stringValue = ""
        errorLabel.isHidden = true
        loadApplicationIcon(preferredPath: newState.appPath)
    }

    func showLoadingFailure(_ message: String) {
        state = nil
        statusPill.update(text: "读取失败", tint: .systemRed)
        themeLabel.stringValue = "无法读取最近皮肤"
        actionButton.title = "重新读取"
        setControlsEnabled(true)
        errorLabel.stringValue = message
        errorLabel.isHidden = false
    }

    func showRunning() {
        statusPill.update(text: "恢复中", tint: .systemOrange)
        actionButton.title = "正在恢复…"
        setControlsEnabled(false)
        errorLabel.stringValue = ""
        errorLabel.isHidden = true
    }

    func showActionFailure(_ message: String) {
        statusPill.update(text: "恢复失败", tint: .systemRed)
        actionButton.title = "恢复失败，点击重试"
        setControlsEnabled(state?.appInstalled == true)
        errorLabel.stringValue = message
        errorLabel.isHidden = false
    }

    func showClosing() {
        statusPill.update(text: "关闭中", tint: .systemOrange)
        actionButton.title = definition.actionTitle
        setControlsEnabled(false)
        errorLabel.stringValue = ""
        errorLabel.isHidden = true
    }

    func showClosed() {
        statusPill.update(text: "已关闭", tint: .secondaryLabelColor)
        actionButton.title = definition.actionTitle
        setControlsEnabled(state?.appInstalled == true)
        errorLabel.stringValue = ""
        errorLabel.isHidden = true
    }

    func showCloseFailure(_ message: String) {
        statusPill.update(text: "关闭失败", tint: .systemRed)
        actionButton.title = definition.actionTitle
        setControlsEnabled(state?.appInstalled == true)
        errorLabel.stringValue = message
        errorLabel.isHidden = false
    }

    func showRepairing() {
        statusPill.update(text: "修复中", tint: .systemOrange)
        actionButton.title = "正在修复…"
        setControlsEnabled(false)
        errorLabel.stringValue = ""
        errorLabel.isHidden = true
    }

    func showRepairQueued() {
        statusPill.update(text: "修复已启动", tint: .systemGreen)
        actionButton.title = definition.actionTitle
        setControlsEnabled(false)
        errorLabel.stringValue = ""
        errorLabel.isHidden = true
    }

    private func loadApplicationIcon(preferredPath: String? = nil) {
        let preferredURL = preferredPath.map { URL(fileURLWithPath: $0, isDirectory: true) }
        let appURL = preferredURL ?? NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: definition.bundleIdentifier
        )
        if let appURL, FileManager.default.fileExists(atPath: appURL.path) {
            appIcon.image = NSWorkspace.shared.icon(forFile: appURL.path)
            return
        }
        let fallbackSymbol = definition.id == .codex
            ? "chevron.left.forwardslash.chevron.right"
            : "person.2.fill"
        appIcon.image = NSImage(
            systemSymbolName: fallbackSymbol,
            accessibilityDescription: "\(definition.title) 应用图标"
        )
    }

    private func setControlsEnabled(_ enabled: Bool) {
        actionButton.isEnabled = enabled
        actionButton.alphaValue = enabled ? 1 : 0.48
        closeButton.isEnabled = enabled
        closeButton.alphaValue = enabled ? 1 : 0.48
    }

    var currentState: LauncherProductState? { state }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var cards: [ProductID: ProductCardView] = [:]
    private var installRoot: URL?
    private var launcherVersion: String?
    private var actionInFlight = false
    private var loadedProducts = Set<ProductID>()
    private let repairButton = NSButton(title: "一键修复", target: nil, action: nil)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        do {
            let metadata = try readBundleMetadata()
            installRoot = metadata.root
            launcherVersion = metadata.version
            buildWindow()
            loadAllStates()
        } catch {
            showFatal(error.localizedDescription)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func readBundleMetadata() throws -> (root: URL, version: String) {
        guard let root = Bundle.main.object(forInfoDictionaryKey: "HeiGeInstallRoot") as? String,
              root.hasPrefix("/") else {
            throw LauncherError.invalidBundle("启动器缺少稳定安装路径，请重新运行安装器。")
        }
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              version.range(of: #"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"#,
                            options: .regularExpression) != nil else {
            throw LauncherError.invalidBundle("启动器版本无效，请重新运行安装器。")
        }
        let rootURL = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL
        guard rootURL.path == root || rootURL.path + "/" == root else {
            throw LauncherError.invalidBundle("启动器安装路径不是规范绝对路径。")
        }
        return (rootURL, version)
    }

    private func buildWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 450),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "HeiGe 皮肤启动器"
        window.center()
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true

        let content = LauncherBackdropView()

        let logo = BrandLogoView()
        logo.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            logo.widthAnchor.constraint(equalToConstant: 62),
            logo.heightAnchor.constraint(equalToConstant: 62),
        ])
        let title = NSTextField(labelWithString: "HeiGe 皮肤启动器")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        title.textColor = .labelColor
        let subtitle = NSTextField(labelWithString: "打开、关闭或一键修复 Codex 与 WorkBuddy 皮肤")
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor
        let textStack = NSStackView(views: [title, subtitle])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 4
        let brand = NSStackView(views: [logo, textStack])
        brand.orientation = .horizontal
        brand.alignment = .centerY
        brand.spacing = 14
        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let platform = StatusPillView(
            text: "MAC 专属 · \(launcherVersion ?? "未知版本")",
            tint: .systemTeal
        )
        let header = NSStackView(views: [brand, headerSpacer, platform])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.distribution = .fill

        let definitions = ProductDefinition.all
        let productCards = definitions.map { definition -> ProductCardView in
            let card = ProductCardView(definition: definition)
            card.onAction = { [weak self] selected in self?.performOpen(selected) }
            card.onClose = { [weak self] selected in self?.performClose(selected) }
            cards[definition.id] = card
            return card
        }
        let cardStack = NSStackView(views: productCards)
        cardStack.orientation = .horizontal
        cardStack.alignment = .top
        cardStack.spacing = 18

        let safety = StatusPillView(text: "本机安全恢复", tint: .systemGreen)
        let codexPort = StatusPillView(text: "Codex · 9341", tint: .systemTeal)
        let workbuddyPort = StatusPillView(text: "WorkBuddy · 9342", tint: .systemIndigo)
        let footerSpacer = NSView()
        footerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        repairButton.target = self
        repairButton.action = #selector(performRepair)
        repairButton.image = NSImage(systemSymbolName: "wand.and.stars", accessibilityDescription: nil)
        repairButton.imagePosition = .imageLeading
        repairButton.bezelStyle = .rounded
        repairButton.controlSize = .small
        repairButton.font = .systemFont(ofSize: 11, weight: .semibold)
        repairButton.contentTintColor = .systemTeal
        repairButton.setAccessibilityLabel("一键修复已安装产品的皮肤")
        repairButton.isEnabled = false
        let diagnostics = NSButton(title: "诊断与日志", target: self, action: #selector(openDiagnostics))
        diagnostics.image = NSImage(
            systemSymbolName: "wrench.and.screwdriver.fill",
            accessibilityDescription: nil
        )
        diagnostics.imagePosition = .imageLeading
        diagnostics.isBordered = false
        diagnostics.contentTintColor = .controlAccentColor
        diagnostics.font = .systemFont(ofSize: 11, weight: .medium)
        let footer = NSStackView(views: [safety, codexPort, workbuddyPort, footerSpacer, repairButton, diagnostics])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.distribution = .fill
        footer.spacing = 8

        let stack = NSStackView(views: [header, cardStack, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            cardStack.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    private func fixedScript(_ name: String) throws -> URL {
        guard let root = installRoot else { throw LauncherError.invalidBundle("稳定安装路径未加载") }
        let script = root.appendingPathComponent("scripts", isDirectory: true)
            .appendingPathComponent(name, isDirectory: false)
            .standardizedFileURL
        guard script.path.hasPrefix(root.path + "/scripts/") else {
            throw LauncherError.invalidBundle("启动器脚本路径越界")
        }
        return script
    }

    private func loadAllStates() {
        for definition in ProductDefinition.all { loadState(definition) }
    }

    private func loadState(_ definition: ProductDefinition) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result: Result<LauncherProductState, Error> = Result {
                let script = try self.fixedScript("launcher-state.command")
                guard let root = self.installRoot else { throw LauncherError.invalidBundle("稳定安装路径未加载") }
                let output = try ProcessRunner.run(
                    executable: script,
                    arguments: [definition.id.rawValue],
                    currentDirectory: root
                )
                guard output.status == 0 else {
                    throw LauncherError.commandFailed(self.safeMessage(output.stderr))
                }
                let state = try JSONDecoder().decode(LauncherProductState.self, from: output.stdout)
                return try state.validated(for: definition)
            }
            DispatchQueue.main.async {
                guard let card = self.cards[definition.id] else { return }
                switch result {
                case .success(let state): card.showReady(state)
                case .failure(let error): card.showLoadingFailure(self.safeMessage(error.localizedDescription))
                }
                self.loadedProducts.insert(definition.id)
                self.updateRepairAvailability()
            }
        }
    }

    private func performOpen(_ definition: ProductDefinition) {
        guard !actionInFlight else { NSSound.beep(); return }
        guard let card = cards[definition.id] else { return }
        guard card.currentState?.appInstalled == true else {
            loadState(definition)
            return
        }
        guard let version = launcherVersion else {
            card.showActionFailure("启动器版本未加载")
            return
        }
        actionInFlight = true
        card.showRunning()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result: Result<Void, Error> = Result {
                let script = try self.fixedScript("launch-skin.command")
                guard let root = self.installRoot else { throw LauncherError.invalidBundle("稳定安装路径未加载") }
                let output = try ProcessRunner.run(
                    executable: script,
                    arguments: [version, definition.id.rawValue],
                    currentDirectory: root
                )
                guard output.status == 0 else {
                    throw LauncherError.commandFailed(self.safeMessage(output.stderr))
                }
            }
            DispatchQueue.main.async {
                switch result {
                case .success:
                    self.activateTarget(definition, state: card.currentState)
                case .failure(let error):
                    self.actionInFlight = false
                    card.showActionFailure(self.safeMessage(error.localizedDescription))
                    self.updateRepairAvailability()
                }
            }
        }
    }

    private func performClose(_ definition: ProductDefinition) {
        guard !actionInFlight else { NSSound.beep(); return }
        guard let card = cards[definition.id] else { return }
        guard card.currentState?.appInstalled == true else {
            loadState(definition)
            return
        }
        guard let version = launcherVersion else {
            card.showCloseFailure("启动器版本未加载")
            return
        }
        actionInFlight = true
        card.showClosing()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result: Result<Void, Error> = Result {
                let script = try self.fixedScript("close-skin.command")
                guard let root = self.installRoot else { throw LauncherError.invalidBundle("稳定安装路径未加载") }
                let output = try ProcessRunner.run(
                    executable: script,
                    arguments: [version, definition.id.rawValue],
                    currentDirectory: root
                )
                guard output.status == 0 else {
                    throw LauncherError.commandFailed(self.safeMessage(output.stderr))
                }
            }
            DispatchQueue.main.async {
                self.actionInFlight = false
                switch result {
                case .success: card.showClosed()
                case .failure(let error): card.showCloseFailure(self.safeMessage(error.localizedDescription))
                }
                self.updateRepairAvailability()
            }
        }
    }

    @objc private func performRepair() {
        guard !actionInFlight else { NSSound.beep(); return }
        guard let version = launcherVersion else {
            showRepairSummary(successes: [], failures: ["启动器版本未加载"])
            return
        }
        let installed = ProductDefinition.all.filter { definition in
            cards[definition.id]?.currentState?.appInstalled == true
        }
        guard !installed.isEmpty else {
            showRepairSummary(successes: [], failures: ["没有找到可修复的 Codex 或 WorkBuddy"])
            return
        }

        actionInFlight = true
        repairButton.isEnabled = false
        repairButton.title = "修复中…"
        for definition in installed { cards[definition.id]?.showRepairing() }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var successes: [String] = []
            var failures: [String] = []
            for definition in installed {
                do {
                    let script = try self.fixedScript("repair-skin.command")
                    guard let root = self.installRoot else { throw LauncherError.invalidBundle("稳定安装路径未加载") }
                    let output = try ProcessRunner.run(
                        executable: script,
                        arguments: [version, definition.id.rawValue],
                        currentDirectory: root
                    )
                    guard output.status == 0 else {
                        throw LauncherError.commandFailed(self.safeMessage(output.stderr))
                    }
                    successes.append(definition.title)
                } catch {
                    failures.append("\(definition.title)：\(self.safeMessage(error.localizedDescription))")
                }
            }
            DispatchQueue.main.async {
                self.actionInFlight = false
                self.repairButton.title = "一键修复"
                for definition in installed {
                    if successes.contains(definition.title) {
                        self.cards[definition.id]?.showRepairQueued()
                    } else if let failure = failures.first(where: { $0.hasPrefix(definition.title + "：") }) {
                        self.cards[definition.id]?.showActionFailure(failure)
                    }
                }
                self.updateRepairAvailability()
                self.showRepairSummary(successes: successes, failures: failures)
            }
        }
    }

    private func showRepairSummary(successes: [String], failures: [String]) {
        let alert = NSAlert()
        alert.messageText = failures.isEmpty ? "皮肤修复已启动" : "皮肤修复结果"
        var lines: [String] = []
        if !successes.isEmpty {
            lines.append("已启动：\(successes.joined(separator: "、"))。目标应用正在重启并恢复最近皮肤。")
        }
        if !failures.isEmpty { lines.append("未完成：\(failures.joined(separator: "；"))") }
        alert.informativeText = lines.joined(separator: "\n")
        alert.alertStyle = failures.isEmpty ? .informational : .warning
        alert.addButton(withTitle: "好")
        alert.runModal()
        if failures.isEmpty && !successes.isEmpty { NSApp.terminate(nil) }
    }

    private func updateRepairAvailability() {
        let stateLoadingFinished = loadedProducts.count == ProductDefinition.all.count
        let hasInstalledProduct = ProductDefinition.all.contains { definition in
            cards[definition.id]?.currentState?.appInstalled == true
        }
        repairButton.isEnabled = !actionInFlight && stateLoadingFinished && hasInstalledProduct
    }

    private func activateTarget(_ definition: ProductDefinition, state: LauncherProductState?) {
        if let running = NSRunningApplication.runningApplications(
            withBundleIdentifier: definition.bundleIdentifier
        ).first, running.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) {
            NSApp.terminate(nil)
            return
        }
        guard let appPath = state?.appPath else {
            actionInFlight = false
            cards[definition.id]?.showActionFailure("皮肤已提交，但没有找到可前置的 APP")
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: appPath, isDirectory: true),
            configuration: configuration
        ) { [weak self] _, error in
            DispatchQueue.main.async {
                if let error {
                    self?.actionInFlight = false
                    self?.cards[definition.id]?.showActionFailure(
                        self?.safeMessage(error.localizedDescription) ?? "无法打开目标 APP"
                    )
                } else {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    private func safeMessage(_ data: Data) -> String {
        safeMessage(String(decoding: data.prefix(1200), as: UTF8.self))
    }

    private func safeMessage(_ value: String) -> String {
        let scalars = value.unicodeScalars.filter { scalar in
            scalar.value >= 0x20 && scalar.value != 0x7f
        }
        let cleaned = String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? "启动器运行失败，请重新运行安装器。" : String(cleaned.prefix(600))
    }

    @objc private func openDiagnostics() {
        let support = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        let candidates = ["HeiGeCodexSkinStudio", "HeiGeCodexSkinStudio-workbuddy"]
            .map { support.appendingPathComponent($0, isDirectory: true) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        if candidates.isEmpty {
            NSWorkspace.shared.open(support)
        } else {
            for url in candidates { NSWorkspace.shared.open(url) }
        }
    }

    private func showFatal(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "HeiGe 皮肤启动器"
        alert.informativeText = safeMessage(message)
        alert.addButton(withTitle: "好")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
