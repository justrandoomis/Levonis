import UIKit
import Capacitor
import CryptoKit

final class LevoBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginType(LevoPrinterPlugin.self)
    }
}

@objc(LevoPrinterPlugin)
final class LevoPrinterPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "LevoPrinterPlugin"
    let jsName = "LevoPrinter"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getEnvironment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoverPrinters", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginPrintJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writePrintJobChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitPrintJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPrintJob", returnType: CAPPluginReturnPromise)
    ]

    private struct Transfer {
        let directory: URL
        let projectBytes: Int
        let gcodeBytes: Int
        var nextProjectChunk = 0
        var nextGcodeChunk = 0
    }

    private let queue = DispatchQueue(label: "iq.levo.studio.printer-bridge")
    private var transfers: [String: Transfer] = [:]
    private let unavailable = "The Bambu LAN transport is not enabled in this bridge build."

    @objc func getEnvironment(_ call: CAPPluginCall) {
        call.resolve([
            "native": true,
            "platform": "ios",
            "bridgeVersion": "0.1.0",
            "capabilities": [
                "discovery": false,
                "lanConnection": false,
                "telemetry": false,
                "rawGcodePrintJob": false,
                "packagePrintJob": false,
                "fileTransfer": false,
                "startPrint": false
            ]
        ])
    }

    @objc func discoverPrinters(_ call: CAPPluginCall) { call.resolve(["printers": []]) }
    @objc func connect(_ call: CAPPluginCall) { call.reject(unavailable) }
    @objc func disconnect(_ call: CAPPluginCall) { call.resolve(["connected": false]) }
    @objc func getStatus(_ call: CAPPluginCall) { call.resolve(["connected": false, "state": "offline"]) }

    @objc func beginPrintJob(_ call: CAPPluginCall) {
        guard let projectBytes = call.getInt("projectBytes"), projectBytes >= 0,
              let gcodeBytes = call.getInt("gcodeBytes"), gcodeBytes >= 0 else {
            call.reject("Invalid print-job sizes.")
            return
        }
        queue.async {
            do {
                let id = UUID().uuidString.lowercased()
                let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("levo-print-transfers", isDirectory: true)
                    .appendingPathComponent(id, isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                FileManager.default.createFile(atPath: root.appendingPathComponent("project.3mf.part").path, contents: nil)
                FileManager.default.createFile(atPath: root.appendingPathComponent("plate.gcode.part").path, contents: nil)
                self.transfers[id] = Transfer(directory: root, projectBytes: projectBytes, gcodeBytes: gcodeBytes)
                call.resolve(["transferId": id])
            } catch {
                call.reject("Could not prepare the encrypted local transfer area.", nil, error)
            }
        }
    }

    @objc func writePrintJobChunk(_ call: CAPPluginCall) {
        guard let transferId = call.getString("transferId"),
              let asset = call.getString("asset"), asset == "project" || asset == "gcode",
              let index = call.getInt("index"), index >= 0,
              let encoded = call.getString("base64"),
              let data = Data(base64Encoded: encoded) else {
            call.reject("Invalid print-job chunk.")
            return
        }
        queue.async {
            guard var transfer = self.transfers[transferId] else {
                call.reject("Unknown or expired transfer.")
                return
            }
            let expected = asset == "project" ? transfer.nextProjectChunk : transfer.nextGcodeChunk
            guard index == expected else {
                call.reject("Out-of-order print-job chunk.")
                return
            }
            let file = transfer.directory.appendingPathComponent(asset == "project" ? "project.3mf.part" : "plate.gcode.part")
            do {
                let handle = try FileHandle(forWritingTo: file)
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                try handle.close()
                if asset == "project" { transfer.nextProjectChunk += 1 } else { transfer.nextGcodeChunk += 1 }
                self.transfers[transferId] = transfer
                call.resolve(["accepted": true])
            } catch {
                call.reject("Could not stage the print-job chunk.", nil, error)
            }
        }
    }

    @objc func commitPrintJob(_ call: CAPPluginCall) {
        guard let transferId = call.getString("transferId"),
              let projectDigest = call.getString("projectSha256"),
              let gcodeDigest = call.getString("gcodeSha256") else {
            call.reject("Missing print-job checksums.")
            return
        }
        queue.async {
            guard let transfer = self.transfers[transferId] else {
                call.reject("Unknown or expired transfer.")
                return
            }
            do {
                let project = try Data(contentsOf: transfer.directory.appendingPathComponent("project.3mf.part"))
                let gcode = try Data(contentsOf: transfer.directory.appendingPathComponent("plate.gcode.part"))
                guard project.count == transfer.projectBytes, gcode.count == transfer.gcodeBytes,
                      Self.hexDigest(project) == projectDigest.lowercased(),
                      Self.hexDigest(gcode) == gcodeDigest.lowercased() else {
                    throw NSError(domain: "LevoPrinter", code: 1, userInfo: [NSLocalizedDescriptionKey: "Print-job checksum validation failed."])
                }
                try? FileManager.default.removeItem(at: transfer.directory)
                self.transfers.removeValue(forKey: transferId)
                call.reject(self.unavailable)
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    @objc func cancelPrintJob(_ call: CAPPluginCall) {
        guard let transferId = call.getString("transferId") else { call.resolve(); return }
        queue.async {
            if let transfer = self.transfers.removeValue(forKey: transferId) {
                try? FileManager.default.removeItem(at: transfer.directory)
            }
            call.resolve()
        }
    }

    private static func hexDigest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
