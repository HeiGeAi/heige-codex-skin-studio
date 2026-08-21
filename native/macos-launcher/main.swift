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
            badge: "当前会话",
            actionTitle: "恢复 Codex 皮肤",
            note: "是否常驻仍由 Codex 顶部菜单决定。",
            bundleIdentifier: "com.openai.codex"
        ),
        ProductDefinition(
            id: .workbuddy,
            title: "WorkBuddy",
            badge: "一次性皮肤",
            actionTitle: "打开 WorkBuddy 皮肤",
            note: "重启 WorkBuddy 后需要再次打开。",
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

final class BrandLogoView: AppearanceSurfaceView {
    private let icon = NSImageView()

    init() {
        super.init(
            borderColor: .separatorColor.withAlphaComponent(0.28),
            cornerRadius: 14,
            borderWidth: 0.5
        )
        layer?.masksToBounds = true

        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns") {
            icon.image = NSImage(contentsOf: iconURL)
        } else {
            icon.image = NSApp.applicationIconImage
        }
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.imageAlignment = .alignCenter
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.setAccessibilityLabel("初音未来主题图标")
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

    private let badgeLabel = NSTextField(labelWithString: "读取中")
    private let themeLabel = NSTextField(labelWithString: "正在读取最近皮肤…")
    private let actionButton = NSButton(title: "读取中…", target: nil, action: nil)
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private var state: LauncherProductState?

    init(definition: ProductDefinition) {
        self.definition = definition
        super.init(
            backgroundColor: .windowBackgroundColor,
            borderColor: .separatorColor.withAlphaComponent(0.55),
            cornerRadius: 16,
            borderWidth: 1
        )

        let appMark = NSTextField(labelWithString: definition.id == .codex ? "C" : "W")
        appMark.font = .systemFont(ofSize: 16, weight: .bold)
        appMark.textColor = .white
        appMark.alignment = .center
        appMark.wantsLayer = true
        appMark.layer?.cornerRadius = 9
        appMark.layer?.backgroundColor = definition.id == .codex
            ? NSColor.black.cgColor
            : NSColor.systemIndigo.cgColor
        appMark.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            appMark.widthAnchor.constraint(equalToConstant: 36),
            appMark.heightAnchor.constraint(equalToConstant: 36),
        ])

        let title = NSTextField(labelWithString: definition.title)
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = .labelColor
        let identity = NSStackView(views: [appMark, title])
        identity.orientation = .horizontal
        identity.alignment = .centerY
        identity.spacing = 10

        badgeLabel.font = .systemFont(ofSize: 10, weight: .medium)
        badgeLabel.textColor = .secondaryLabelColor
        let header = NSStackView(views: [identity, badgeLabel])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.distribution = .fill

        let recentTitle = NSTextField(labelWithString: "最近使用的皮肤")
        recentTitle.font = .systemFont(ofSize: 11)
        recentTitle.textColor = .secondaryLabelColor
        themeLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        themeLabel.textColor = .labelColor
        themeLabel.lineBreakMode = .byTruncatingTail
        let recentContent = NSStackView(views: [recentTitle, themeLabel])
        recentContent.orientation = .vertical
        recentContent.alignment = .leading
        recentContent.spacing = 4
        recentContent.translatesAutoresizingMaskIntoConstraints = false
        let recent = AppearanceSurfaceView(backgroundColor: .controlBackgroundColor, cornerRadius: 10)
        recent.addSubview(recentContent)
        NSLayoutConstraint.activate([
            recentContent.leadingAnchor.constraint(equalTo: recent.leadingAnchor, constant: 11),
            recentContent.trailingAnchor.constraint(equalTo: recent.trailingAnchor, constant: -11),
            recentContent.topAnchor.constraint(equalTo: recent.topAnchor, constant: 10),
            recentContent.bottomAnchor.constraint(equalTo: recent.bottomAnchor, constant: -10),
        ])

        actionButton.target = self
        actionButton.action = #selector(actionClicked)
        actionButton.bezelStyle = .rounded
        actionButton.controlSize = .large
        actionButton.isEnabled = false

        let note = NSTextField(wrappingLabelWithString: definition.note)
        note.font = .systemFont(ofSize: 10)
        note.textColor = .secondaryLabelColor
        errorLabel.font = .systemFont(ofSize: 10, weight: .medium)
        errorLabel.textColor = .systemRed
        errorLabel.maximumNumberOfLines = 2

        let stack = NSStackView(views: [header, recent, actionButton, note, errorLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            recent.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actionButton.widthAnchor.constraint(equalTo: stack.widthAnchor),
            errorLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 24),
            widthAnchor.constraint(equalToConstant: 318),
            heightAnchor.constraint(equalToConstant: 246),
        ])
    }

    required init?(coder: NSCoder) { nil }

    @objc private func actionClicked() {
        onAction?(definition)
    }

    func showReady(_ newState: LauncherProductState) {
        state = newState
        badgeLabel.stringValue = newState.appInstalled ? definition.badge : "未安装"
        themeLabel.stringValue = newState.themeName
        actionButton.title = definition.actionTitle
        actionButton.isEnabled = newState.appInstalled
        errorLabel.stringValue = ""
    }

    func showLoadingFailure(_ message: String) {
        state = nil
        badgeLabel.stringValue = "读取失败"
        themeLabel.stringValue = "无法读取最近皮肤"
        actionButton.title = "重新读取"
        actionButton.isEnabled = true
        errorLabel.stringValue = message
    }

    func showRunning() {
        actionButton.title = "正在恢复…"
        actionButton.isEnabled = false
        errorLabel.stringValue = ""
    }

    func showActionFailure(_ message: String) {
        actionButton.title = "恢复失败，点击重试"
        actionButton.isEnabled = state?.appInstalled == true
        errorLabel.stringValue = message
    }

    var currentState: LauncherProductState? { state }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var cards: [ProductID: ProductCardView] = [:]
    private var installRoot: URL?
    private var launcherVersion: String?
    private var actionInFlight = false

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
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 450),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "HeiGe 皮肤启动器"
        window.center()
        window.isReleasedWhenClosed = false

        let content = AppearanceSurfaceView(backgroundColor: .windowBackgroundColor)

        let logo = BrandLogoView()
        logo.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            logo.widthAnchor.constraint(equalToConstant: 50),
            logo.heightAnchor.constraint(equalToConstant: 50),
        ])
        let title = NSTextField(labelWithString: "HeiGe 皮肤启动器")
        title.font = .systemFont(ofSize: 21, weight: .bold)
        title.textColor = .labelColor
        let subtitle = NSTextField(labelWithString: "选择要恢复皮肤的产品")
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor
        let textStack = NSStackView(views: [title, subtitle])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 4
        let header = NSStackView(views: [logo, textStack])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 13

        let definitions = ProductDefinition.all
        let productCards = definitions.map { definition -> ProductCardView in
            let card = ProductCardView(definition: definition)
            card.onAction = { [weak self] selected in self?.performAction(selected) }
            cards[definition.id] = card
            return card
        }
        let cardStack = NSStackView(views: productCards)
        cardStack.orientation = .horizontal
        cardStack.alignment = .top
        cardStack.spacing = 16

        let isolation = NSTextField(labelWithString: "两个产品使用独立状态与端口：Codex 9341，WorkBuddy 9342")
        isolation.font = .systemFont(ofSize: 10)
        isolation.textColor = .secondaryLabelColor
        let diagnostics = NSButton(title: "查看诊断与日志", target: self, action: #selector(openDiagnostics))
        diagnostics.isBordered = false
        diagnostics.contentTintColor = .controlAccentColor
        let footer = NSStackView(views: [isolation, diagnostics])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.distribution = .fill

        let stack = NSStackView(views: [header, cardStack, footer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 26),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -26),
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
            }
        }
    }

    private func performAction(_ definition: ProductDefinition) {
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
                }
            }
        }
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
