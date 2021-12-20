import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { ActionArguments, parseArgs } from './arguments'
import { runComparison } from './results'
import { tryExec } from './util'

async function run(): Promise<void> {
  try {
    const args = await parseArgs() // Parses args using core.getInput

    core.debug(`Entering setup phase`)
    await runSetup(args.doFetch, args.doClean)
    core.debug(`Setup completed.`)

    // The arguments passed to criterion: these come after the `--` in the command
    let benchArgs: string[] = []
    if (args.benchName) {
      benchArgs = benchArgs.concat(['--bench', args.benchName])
    }
    const options = { cwd: args.workDir }

    core.debug(`Starting benchmark of changes`)
    const changesBenchRC = await runBench(args, 'changes', options)
    console.debug(`Benchmark command returned ${changesBenchRC}`)

    core.debug(`Checking out branch ${args.branchName}`)
    const gitRC = await exec.exec('git', ['checkout', args.branchName])
    if (gitRC !== 0) {
      core.error('Git checkout failed! Bailing out.')
      throw new Error(`Git checkout failed`)
    }

    core.debug(`Starting benchmark of ${args.branchName}`)
    let baseBenchRC = await runBench(args, 'base', options)
    console.debug(`Benchmark command returned ${baseBenchRC}`)

    let compareResults = await runComparison(args)

    let resultsObj = compareResults[0]
    let tableStr = compareResults[1]

    core.setOutput('results_markdown', tableStr)
    core.setOutput('results_json', JSON.stringify(resultsObj))

    if (args.doComment) {
      await postComment(args.token, tableStr)
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

  let cargoS = await tryExec('cargo', ['install', 'critcmp'])
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
async function runBench(
  args: ActionArguments,
  baselineName: string,
  options: object
): Promise<number> {
  let fullArgs = ['bench']

  if (args.benchName) {
    fullArgs.push('--bench', args.benchName)
  }
  fullArgs.push('--')
  fullArgs.push('--save-baseline', baselineName)

  let rc = await exec.exec('cargo', fullArgs, options)
  return rc
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