export class ActionArguments {
  token: string
  workDir: string
  benchName: string
  branchName: string
  doFetch: boolean

  constructor(
    token: string,
    cwd: string,
    branch: string,
    bench: string,
    fetch: boolean
  ) {
    this.token = token
    this.workDir = cwd
    this.branchName = branch
    this.benchName = bench
    this.doFetch = fetch
  }
}
