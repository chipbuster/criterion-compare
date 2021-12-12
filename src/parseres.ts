import {ActionArguments} from './datastructs'

async function parseResults(args: ActionArguments): Promise<void> {
  let myOutput: string
  let myError: string
  const options = {
    cwd: args.workDir,
    listeners: {
      stdout: (data: any) => {
        myOutput += data.toString()
      },
      stderr: (data: any) => {
        myError += data.toString()
      }
    }
  }
}
