import { chromium, type Page } from "@playwright/test"

// CDP attach to the developer's running Chrome. The existing localStorage
// token is the auth for both UI and API calls — never automate login when
// a real session already exists.
export const CDP_ENDPOINT = process.env.E2E_CDP_ENDPOINT || "http://localhost:9222"
export const APP_URL = process.env.E2E_APP_URL || "http://localhost:3000"

export async function getAppPage(): Promise<Page> {
  let browser
  try {
    // noDefaults: Chrome 155+ rejects browser-level Browser.setDownloadBehavior
    browser = await chromium.connectOverCDP(CDP_ENDPOINT, { noDefaults: true })
  } catch {
    throw new Error(
      `Cannot connect to Chrome at ${CDP_ENDPOINT}.\n` +
      "Quit Chrome completely, then relaunch with remote debugging:\n" +
      "  Linux:   google-chrome --remote-debugging-port=9222 --restore-last-session &\n" +
      "  macOS:   open -a 'Google Chrome' --args --remote-debugging-port=9222\n" +
      "Your tabs and logged-in session are preserved."
    )
  }
  const context = browser.contexts()[0]
  if (!context) throw new Error("No browser context on CDP connection.")
  const page = context.pages().find((p) => p.url().startsWith(APP_URL))
  if (!page) {
    const any = context.pages()[0]
    if (!any) throw new Error("No open tab found in the connected Chrome.")
    await any.goto(APP_URL)
    return any
  }
  return page
}
