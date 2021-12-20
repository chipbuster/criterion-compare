import * as core from '@actions/core'
export class ActionArguments {
  token: string
  workDir: string
  benchName: string
  branchName: string
  doFetch: boolean
  doClean: boolean
  doComment: boolean

  constructor(
    token: string,
    cwd: string,
    branch: string,
    bench: string,
    fetch: boolean,
    clean: boolean,
    comment: boolean
  ) {
    this.token = token
    this.workDir = cwd
    this.branchName = branch
    this.benchName = bench
    this.doFetch = fetch
    this.doClean = clean
    this.doComment = comment
  }
}

/** Obtains arguments for Actions run. */
export async function parseArgs(): Promise<ActionArguments> {
  const token = core.getInput('token')
  const workDir = core.getInput('workDir')
  const branchName = core.getInput('gitBranchName')
  const benchName = core.getInput('cargoBenchName')
  const doFetch = core.getBooleanInput('doFetch')
  const doClean = core.getBooleanInput('doClean')
  const doComment = core.getBooleanInput('doComment')

  let args = new ActionArguments(token, workDir, branchName, benchName, doFetch, doClean, doComment)

  core.debug(`Parsing phase finished. Got argument values:`)
  core.debug(`\ttoken: ${args.token}`)
  core.debug(`\tcwd: ${args.workDir}`)
  core.debug(`\tcargoBenchName: ${args.benchName}`)
  core.debug(`\tgitBranchName: ${args.branchName}`)
  core.debug(`\tdoFetch: ${args.doFetch}`)
  core.debug(`\tdoClean: ${args.doClean}`)
  core.debug(`\tdoComment: ${args.doComment}`)

  return args
}