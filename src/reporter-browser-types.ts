/** The slice of Playwright's `BrowserType` the reporter actually uses. */
export interface BrowserTypeLike {
  executablePath(): string
}
