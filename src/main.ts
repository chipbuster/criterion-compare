import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { ActionArguments, parseArgs } from './arguments'
import { genBenchmarkResultTable } from './results'
import { tryExec, execCapture, CommandResult, checkExitStatus } from './util'

async function run(): Promise<void> {
  try {
    const args = await parseArgs() // Parses args using core.getInput

    core.debug(`Entering setup phase`)
    await runSetup(args.doFetch, args.doClean)
    core.debug(`Setup completed.`)

    // Since cargo criterion gives us changes from the last benchmark, we should
    // checkout and benchmark the base branch first.

    core.debug(`Checking out branch ${args.branchName}`)
    const gitRCBase = await exec.exec('git', ['checkout', args.branchName])
    checkExitStatus(gitRCBase, 'git checkout')

    core.debug(`Starting benchmark of base code`)
    const baseBenchRes = await runBench(args)
    checkExitStatus(
      baseBenchRes.exitCode,
      `Benchmark command ${baseBenchRes.command}`
    )

    // Now we do the same thing for the PR

    const pr_sha = github.context.sha
    const gitRCPR = await exec.exec('git', ['checkout', pr_sha])
    checkExitStatus(gitRCPR, 'git checkout')

    core.debug(`Starting benchmark of proposed changes`)
    let deltaBenchRes = await runBench(args)
    checkExitStatus(
      deltaBenchRes.exitCode,
      `Benchmark command ${deltaBenchRes.command}`
    )

    let compareResults = await genBenchmarkResultTable(deltaBenchRes.stdOut)

    core.setOutput('results_markdown', compareResults)

    if (args.doComment) {
      await postComment(args.token, compareResults)
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

/**
 * Runs setup actions: install critcmp and git fetch. Changes the state of the
 * actions system: repository will be fetched and critcmp will be installed.
 * @param doFetch Whether to perform a git fetch as part of setup
 * @param doClean Whether to perform a cargo clean as part of setup
 * @returns A boolean indicating whether setup was successful.
 */
async function runSetup(doFetch: boolean, doClean: boolean): Promise<boolean> {
  core.debug(
    `Attempting to install cargo-criterion + CLI Tools, doFetch is ${doFetch}`
  )

  let cargoS = await tryExec('cargo', ['install', 'cargo-criterion'])
  if (!cargoS) {
    return false
  }

  if (doFetch) {
    let success = await tryExec('git fetch')
    if (!success) {
      return false
    }
  }
  if (doClean) {
    let success = await tryExec('cargo clean')
    if (!success) {
      return false
    }
  }

  return true
}

/**
 * Runs a single benchmarking command
 * @param args Arguments to pass to cargo bench *after* the `--`separator for criterion
 * @param options An object of options to use with exec()
 * @returns The return code of the benchmarking operation
 */
async function runBench(args: ActionArguments): Promise<CommandResult> {
  let fullArgs = ['criterion']
  if (args.benchName) {
    fullArgs.push('--bench')
    fullArgs.push(args.benchName)
  } else {
    fullArgs.push('--benches')
  }

  fullArgs.push('--message-format')
  fullArgs.push('json')

  let res = await execCapture('cargo', fullArgs, args.workDir)
  return res
}

/**
 * Posts a comment to the GitHub repository
 * @param myToken The API Token used for the repo
 * @param results A string containing the contents of the comment (usually in markdown)
 */
async function postComment(myToken: string, results: string): Promise<void> {
  const context = github.context

  // An authenticated instance of `@octokit/rest`
  const octokit = github.getOctokit(myToken)
  const contextObj = { ...context.issue }
  try {
    await octokit.rest.issues.createComment({
      owner: contextObj.owner,
      repo: contextObj.repo,
      issue_number: contextObj.number,
      body: results
    })
  } catch (e) {
    // If we can't post to the comment, display results here.
    // forkedRepos only have READ ONLY access on GITHUB_TOKEN
    // https://github.community/t5/GitHub-Actions/quot-Resource-not-accessible-by-integration-quot-for-adding-a/td-p/33925
    core.warning('Failed to post comment')
    console.log(results)
    console.log(e)
  }
}

run()
