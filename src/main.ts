import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import {ActionArguments} from './datastructs'

async function run(): Promise<void> {
  try {
    core.debug(`Entering parsing phase`)
    let args = await parseArgs() // Parses args using core.getInput

    core.debug(`Entering setup phase`)
    runSetup(args.doFetch)

    let benchArgs = ['bench']
    if (args.benchName) {
      benchArgs = benchArgs.concat(['--bench', args.benchName])
    }
    let options = {cwd: args.workDir}

    core.debug(`Starting benchmark of changes`)
    let changesBenchRC = runBench(
      benchArgs.concat(['--save-baseline', 'changes']),
      options
    )
    console.debug(`Benchmark command returned ${changesBenchRC}`)

    core.debug(`Checking out branch ${args.branchName}`)
    let gitRC = await exec.exec('git', ['checkout', args.branchName])
    if (gitRC !== 0) {
      core.error('Git checkout failed! Bailing out.')
      return
    }

    core.debug(`Starting benchmark of ${args.branchName}`)
    let baseBenchRC = runBench(
      benchArgs.concat(['--save-baseline', 'base']),
      options
    )
    console.debug(`Benchmark command returned ${baseBenchRC}`)

    core.setOutput('time', new Date().toTimeString())
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

/** Obtains arguments for Actions run. */
async function parseArgs(): Promise<ActionArguments> {
  const token = core.getInput('token')
  const workDir = core.getInput('cwd')
  const branchName = core.getInput('gitBranchName')
  const benchName = core.getInput('cargoBenchName')
  const doFetch = core.getBooleanInput('doFetch')

  let args = new ActionArguments(token, workDir, branchName, benchName, doFetch)

  core.debug(`Parsing phase finished. Got argument values:`)
  core.debug(`\ttoken: ${args.token}`)
  core.debug(`\tcwd: ${args.workDir}`)
  core.debug(`\tcargoBenchName: ${args.benchName}`)
  core.debug(`\tgitBranchName: ${args.branchName}`)
  core.debug(`\tdoFetch: ${args.doFetch}`)

  return args
}

/**
 * Runs setup actions: install critcmp and git fetch. Changes the state of the
 * actions system: repository will be fetched and critcmp will be installed.
 * @param doFetch Whether to perform a git fetch as part of setup
 * @returns A boolean indicating whether setup was successful.
 */
async function runSetup(doFetch: boolean): Promise<boolean> {
  core.debug(`Entering setup phase.`)
  core.debug(`Attempting to install cargo-criterion + CLI Tools`)

  let cargoRC = await exec.exec('cargo', ['install', 'critcmp'])
  if (cargoRC !== 0) {
    core.error(`Installation of cargo critcmp failed with code ${cargoRC}`)
    return false
  }

  if (doFetch) {
    let gitRC = await exec.exec('git fetch')
    if (gitRC !== 0) {
      core.error(
        '`git fetch` returned with code ${gitRC}. This may cause issues later on in this Action.'
      )
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
async function runBench(args: string[], options: object): Promise<number> {
  let fullArgs = ['--']
  fullArgs.push(...args)

  core.debug('Executing command: cargo ${...fullArgs} with options ${options}')
  let rc = await exec.exec('cargo', fullArgs, options)
  return rc
}

run()
