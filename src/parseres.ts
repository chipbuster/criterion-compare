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

function convertToMarkdown(results: string) {
  /* Example results:
    group                            changes                                master
    -----                            -------                                ------
    character module                 1.03     22.2±0.41ms        ? B/sec    1.00     21.6±0.53ms        ? B/sec
    directory module – home dir      1.02     21.7±0.69ms        ? B/sec    1.00     21.4±0.44ms        ? B/sec
    full prompt                      1.08     46.0±0.90ms        ? B/sec    1.00     42.7±0.79ms        ? B/sec
  */

  let resultLines = results.trimRight().split('\n')
  let benchResults = resultLines
    .slice(2) // skip headers
    .map(row => row.split(/\s{2,}/)) // split if 2+ spaces together
    .map(
      ([
        name,
        changesFactor_s,
        changesDuration,
        _changesBandwidth,
        masterFactor_s,
        masterDuration,
        _masterBandwidth
      ]) => {
        let masterUndefined = typeof masterDuration === 'undefined'
        let changesUndefined = typeof changesDuration === 'undefined'

        if (!name || (masterUndefined && changesUndefined)) {
          return ''
        }

        let difference = 'N/A'
        if (!masterUndefined && !changesUndefined) {
          let changesFactor = Number(changesFactor)
          let masterFactor: Number = Number(masterFactor)

          let changesDurSplit = changesDuration.split('±')
          let changesUnits = changesDurSplit[1].slice(-2)
          let changesDurSecs = convertDurToSeconds(
            changesDurSplit[0],
            changesUnits
          )
          let changesErrorSecs = convertDurToSeconds(
            changesDurSplit[1].slice(0, -2),
            changesUnits
          )

          let masterDurSplit = masterDuration.split('±')
          let masterUnits = masterDurSplit[1].slice(-2)
          let masterDurSecs = convertDurToSeconds(
            masterDurSplit[0],
            masterUnits
          )
          let masterErrorSecs = convertDurToSeconds(
            masterDurSplit[1].slice(0, -2),
            masterUnits
          )

          difference = -(1 - changesDurSecs / masterDurSecs) * 100
          difference =
            (changesDurSecs <= masterDurSecs ? '' : '+') +
            difference.toFixed(2) +
            '%'
          if (
            isSignificant(
              changesDurSecs,
              changesErrorSecs,
              masterDurSecs,
              masterErrorSecs
            )
          ) {
            if (changesDurSecs < masterDurSecs) {
              changesDuration = `**${changesDuration}**`
            } else if (changesDurSecs > masterDurSecs) {
              masterDuration = `**${masterDuration}**`
            }

            difference = `**${difference}**`
          }
        }

        if (masterUndefined) {
          masterDuration = 'N/A'
        }

        if (changesUndefined) {
          changesDuration = 'N/A'
        }

        return `| ${name} | ${changesDuration} | ${masterDuration} | ${difference} |`
      }
    )
    .join('\n')

  let shortSha = context.sha.slice(0, 7)
  return `## Benchmark for ${shortSha}
  <details>
    <summary>Click to view benchmark</summary>
| Test | PR Benchmark | Master Benchmark | % |
|------|--------------|------------------|---|
${benchResults}
  </details>
  `
}

function convertToTableObject(results: string) {
  /* Example results:
    group                            changes                                master
    -----                            -------                                ------
    character module                 1.03     22.2±0.41ms        ? B/sec    1.00     21.6±0.53ms        ? B/sec
    directory module – home dir      1.02     21.7±0.69ms        ? B/sec    1.00     21.4±0.44ms        ? B/sec
    full prompt                      1.08     46.0±0.90ms        ? B/sec    1.00     42.7±0.79ms        ? B/sec
  */

  let resultLines = results.split('\n')
  let benchResults = resultLines
    .slice(2) // skip headers
    .map(row => row.split(/\s{2,}/)) // split if 2+ spaces together
    .map(
      ([
        name,
        changesFactor,
        changesDuration,
        _changesBandwidth,
        masterFactor,
        masterDuration,
        _masterBandwidth
      ]) => {
        changesFactor = Number(changesFactor)
        masterFactor = Number(masterFactor)

        let difference = -(1 - changesFactor / masterFactor) * 100
        difference =
          (changesFactor <= masterFactor ? '' : '+') + difference.toPrecision(2)
        if (changesFactor < masterFactor) {
          changesDuration = `**${changesDuration}**`
        } else if (changesFactor > masterFactor) {
          masterDuration = `**${masterDuration}**`
        }

        return {
          name,
          changesDuration,
          masterDuration,
          difference
        }
      }
    )

  return benchResults
}
