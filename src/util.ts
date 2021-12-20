/** @module
 * This file contains utility code for running external commands with various
 * options and capturing their results in various forms.
 */

import * as core from '@actions/core'
import * as exec from '@actions/exec'

/**
 * Represents the result of a command executed by exec.exec, with its output
 * and error captured.
 */
class CommandResult {
  exitCode: number
  stdOut: string
  stdErr: string
  constructor(ec: number, out: string, err: string) {
    this.exitCode = ec
    this.stdOut = out
    this.stdErr = err
  }
}

/**
 * Executes a command, returning false if the exit code was non-zero
 * @param cmd The command name to execute. If no `args` provided, is the entire command string
 * @param args The arugments to `cmd`.
 * @param options A set of arguments (as an object) to pass to exec.exec
 */
export async function tryExec(
  cmd: string,
  args: string[],
  options: any
): Promise<boolean>
export async function tryExec(cmd: string, args: string[]): Promise<boolean>
export async function tryExec(cmd: string): Promise<boolean>
export async function tryExec(
  cmd: string,
  args?: string[],
  options?: any
): Promise<boolean> {
  let cmdName
  if (args == null) {
    cmdName = cmd
  } else {
    cmdName = `${cmd} ${args}`
  }
  let rc = await exec.exec(cmd, args, options)
  if (rc !== 0) {
    core.error(`Command \`${cmdName}\` failed with code ${rc}`)
    return false
  }
  return true
}

/**
 *
 * @param cmd The command name to execute.
 * @param args Arguments to the command, as an array
 * @param cwd (optional) The current working directory to use for the command
 * @returns A CommandResult representing the captured output
 */
export async function execCapture(
  cmd: string,
  args: string[],
  cwd?: string
): Promise<CommandResult> {
  let output = ''
  let error = ''

  const options = {
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString()
      },
      stderr: (data: Buffer) => {
        error += data.toString()
      }
    },
    cwd: cwd
  }

  let rc = await exec.exec(cmd, args, options)

  return new CommandResult(rc, output, error)
}
