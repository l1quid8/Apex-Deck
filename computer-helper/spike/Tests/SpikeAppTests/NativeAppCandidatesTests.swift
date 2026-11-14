import AppKit
import XCTest
import SpikeCore
@testable import SpikeApp

final class NativeAppCandidatesTests: XCTestCase {
  private let brave = URL(fileURLWithPath: "/Applications/Brave Browser.app")

  func testRegularHeadlessBrowserDoesNotMakeGUIBrowserAmbiguous() throws {
    let processes = [
      (pid: 10, arguments: ["Brave Browser", "--profile-directory=Default"]),
      (pid: 20, arguments: ["Brave Browser", "--headless=new", "--user-data-dir=/tmp/jigga-tasks/brave"]),
    ]
    let candidates = processes.filter {
      NativeAppCandidates.includes(terminated: false, activationPolicy: .regular, arguments: $0.arguments)
    }
    XCTAssertEqual(candidates.map(\.pid), [10])
    XCTAssertEqual(try AppIdentity.source(running: candidates.map { _ in brave }, registered: nil), brave)
  }

  func testEveryExplicitHeadlessModeIsExcludedEvenWithRegularPolicy() {
    for argument in ["--headless", "--headless=new", "--headless=old", "--headless="] {
      XCTAssertFalse(NativeAppCandidates.includes(terminated: false, activationPolicy: .regular,
        arguments: ["Brave Browser", argument]), argument)
    }
  }

  func testHeadlessTextOutsideAnOptionDoesNotHideAnApp() {
    for arguments in [
      ["Brave Browser", "--user-data-dir=/tmp/headless"],
      ["Brave Browser", "--headlessness"],
      ["Brave Browser", "--headless-file=test"],
      ["Brave Browser", "https://example.com/--headless"],
      ["Brave Browser", "--", "--headless=new"],
      ["--headless"],
    ] {
      XCTAssertTrue(NativeAppCandidates.includes(terminated: false, activationPolicy: .regular,
        arguments: arguments), "\(arguments)")
    }
  }

  func testUnavailableArgumentsKeepTheCandidateForAmbiguityChecks() {
    for policy in [NSApplication.ActivationPolicy.regular, .accessory] {
      XCTAssertTrue(NativeAppCandidates.includes(terminated: false, activationPolicy: policy, arguments: nil))
      XCTAssertTrue(NativeAppCandidates.includes(terminated: false, activationPolicy: policy, arguments: []))
    }
  }

  func testTerminatedAndProhibitedAppsStayExcluded() {
    XCTAssertFalse(NativeAppCandidates.includes(terminated: true, activationPolicy: .regular, arguments: nil))
    XCTAssertFalse(NativeAppCandidates.includes(terminated: false, activationPolicy: .prohibited, arguments: nil))
  }

  func testTwoGUIProcessesRemainAmbiguous() {
    let processes = [
      ["Brave Browser", "--profile-directory=Default"],
      ["Brave Browser", "--user-data-dir=/tmp/another-gui-profile"],
    ]
    let candidates = processes.filter {
      NativeAppCandidates.includes(terminated: false, activationPolicy: .regular, arguments: $0)
    }
    XCTAssertEqual(candidates.count, 2)
    XCTAssertThrowsError(try AppIdentity.source(running: candidates.map { _ in brave }, registered: nil)) {
      XCTAssertEqual(($0 as? Refusal)?.code, "target_ambiguous")
    }
  }
}
