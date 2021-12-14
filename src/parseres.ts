import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {context} from '@actions/github'
import {ActionArguments} from './datastructs'

/**
 * Represents a single benchmark point: one measurement of one trial. All numbers
 * are in nanoseconds except confidenceLevel which is a number in [0,1) and
 * describes the confidence% of the [lowerBound, upperBound] interval (e.g. 95%)
 */
class MeasurementStats {
  kind: string
  pointEstimate: number
  standardError: number | null
  lowerBound: number | null
  upperBound: number | null
  confidenceLevel: number | null

  /** Construct a MeasurementStats from a part of a JSON object */
  constructor(name: string, body: any) {
    this.kind = name
    let pointEstimate = body.point_estimate
    if (typeof pointEstimate !== 'number') {
      console.error(
        "No 'point_estimate' found in JSON--has critcmp changed its JSON format?"
      )
    }
    this.pointEstimate = pointEstimate

    // Execute the somewhat-messy process of ensuring that all our points are defined or null
    // TODO: Rework this to not crash if things are undefined.
    this.standardError = body.standard_error
    this.lowerBound = body.confidence_interval.lower_bound
    this.upperBound = body.confidence_interval.upper_bound
    this.confidenceLevel = body.confidence_interval.confidence_level
  }
}

class BaselineIdentifier {
  baseName: string
  fullName: string
}
class BenchmarkResult {}

async function parseResults(args: ActionArguments): Promise<void> {
  let myOutput = new String()
  let myError = new String()
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

  await exec.exec('critcmp', ['base', 'changes'], options)
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
