import { createWriteStream } from 'fs'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { context } from '@actions/github'
import { ActionArguments } from './datastructs'

/**
 * Represents a single benchmark point: one measurement of one trial. All numbers
 * are in nanoseconds except confidenceLevel which is a number in [0,1) and
 * describes the confidence% of the [lowerBound, upperBound] interval (e.g. 95%)
 */
class MeasurementStats {
  kind: string
  pointEstimate: number
  standardError: number
  lowerBound: number
  upperBound: number
  confidenceLevel: number

  /** Construct a MeasurementStats from a part of a JSON object */
  constructor(body: any) {
    this.kind = body.name
    let pointEstimate = body.point_estimate
    if (typeof pointEstimate !== 'number') {
      core.error(
        "No 'point_estimate' found in JSON--has critcmp changed its JSON format?"
      )
    }
    this.pointEstimate = pointEstimate

    // Default values: confidence level and bounds are set assuming pointEstimate
    // is the only valid estimate (so it's lower and upper bound with no confidence)
    // Standard error is a bit of a hack because I have no idea how to set it
    const CI = body.confidence_interval ?? { lower_bound: pointEstimate, upper_bound: pointEstimate, confidence_level: 0.0 }
    this.standardError = body.standard_error ?? 0.0;
    this.lowerBound = CI.lower_bound ?? pointEstimate;
    this.upperBound = CI.upper_bound ?? pointEstimate;
    this.confidenceLevel = CI.confidence_level ?? 0.0;
  }
}

class BenchmarkResult {
  name: string            // Name of the benchmark (e.g. "run_db_query")
  baseline: string        // Name of the baseline that this result belongs to
  other_id: any           // Other identifiers as needed for the CI
  mean: MeasurementStats | null
  median: MeasurementStats | null

  // Caller needs to make sure this is not null
  constructor(benchmark_obj: any) {
    this.name = benchmark_obj.name ?? "unknown";
    this.baseline = benchmark_obj.baseline ?? "unknown";

    const estimates = benchmark_obj.criterion_estimates_v1;
    if (estimates == null) {
      core.error("Criterion estimates not found. Has data format changed?")
      throw new Error("Benchmark data not found in benchmark object");
    }
    if (estimates.mean == null) {
      this.mean = null;
    } else {
      this.mean = new MeasurementStats(estimates.mean);
    }

    if (estimates.median == null) {
      this.median = null
    } else {
      this.median = new MeasurementStats(estimates.median)
    }

    if (this.median === null && this.mean === null) {
      core.error(`Neither median nor mean were found in benchmark: ${benchmark_obj}`)
      throw new Error("Benchmark data not found in benchmark object");
    }
  }

}


function resultsFromJSONString(s: string): Array<BenchmarkResult> {
  let toplevel = JSON.parse(s);
  if (toplevel.benchmarks == null) {
    console.error("No 'benchmarks' key found in JSON: has data format changed?")
  }

  let out = new Array<BenchmarkResult>();
  for (const [_key, value] of Object.entries(toplevel.benchmarks)) {
    out.push(new BenchmarkResult(value))
  }
  return out;
}

/** Generate two strings and an options object. Used for simple capture of stdout
 * and stderr, e.g. 
 *   let execopts = genOptions(cwd)
 *   let returncode = await exec.exec("mycommand", ["myarg1"], execopts[0])
 *   // stdout can now be read on execopts[1], stderr on execopts[2]
 */
function genRedirectOptions(cwd: string): [any, String, String] {
  let output = new String();
  let error = new String();
  const options = {
    cwd: cwd,
    listeners: {
      stdout: (data: any) => {
        output += data.toString()
      },
      stderr: (data: any) => {
        error += data.toString()
      }
    }
  }

  return [options, output, error]
}

/**
 * Gets comparison results for 
 * @param args Arguments provided to the overall GH Action
 * @returns A tuple containing two filenames. These contain the JSON data for
 *          the benchmark results.
 */
async function runComparison(args: ActionArguments): Promise<void> {
  let baseOpts = genRedirectOptions(args.workDir);
  let changeOpts = genRedirectOptions(args.workDir);
  let rc1 = await exec.exec('critcmp', ['--export', 'base'], baseOpts[0]);
  let rc2 = await exec.exec('critcmp', ['--export', 'changes'], changeOpts[0]);
  if (rc1 !== 0 || rc2 !== 0) {
    core.error(`critcmp failed with codes ${rc1} (for exporting base), ${rc2} (for exporting changes)`)
    core.debug(`base stderr: ${baseOpts[2]}, changes stderr: ${changeOpts[2]}`)
  }
  const baseResults = resultsFromJSONString(baseOpts[1].toString());
  const changeResults = resultsFromJSONString(changeOpts[1].toString());
}

function isSignificant(
  changesDur: number,
  changesErr: number,
  masterDur: number,
  masterErr: number
) {
  if (changesDur < masterDur) {
    return (
      changesDur + changesErr < masterDur || masterDur - masterErr > changesDur
    )
  } else {
    return (
      changesDur - changesErr > masterDur || masterDur + masterErr < changesDur
    )
  }
}
