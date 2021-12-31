/** @module
 * This file contains the code responsible for parsing, processing, and formatting
 * benchmark results.
 * 
 * The primary goal is to generate a markdown table, with one entry per row
 * describing significant benchmarks, e.g.
 * 
 * 
  | Test Name | PR | trunk | % of trunk |
  |-----------|----|-------|------------|
  | solve n=100 | 85.79 ± 0.65 μs | **81.56 ± 0.36 μs** | 5 |

 * We take advantage of the fact that cargo-criterion can output JSON directly
 * (https://bheisler.github.io/criterion.rs/book/cargo_criterion/external_tools.html)
 * to read most of this data out in a nice automated fasihon.
 */

import * as core from '@actions/core'
import * as github from '@actions/github'
import { ActionArguments } from './arguments'
import { execCapture } from './util'

enum ReportFields {
  TestName,
  BaseTime,
  PRTime,
  PctDiff,
  PctDiff_LB,
  PctDiff_UB
}

/**
 * Find the units to display a given number of nanoseconds as.
 * @param s The time, in nanoseconds
 * @returns A string representing the appropriate units to display this quantity
 */
function displayUnits(s: number): string {
  if (0 < s && s < 1000) {
    return 'ns'
  } else if (1000 <= s && s < 1e6) {
    return 'μs'
  } else if (1e6 <= s && s < 1e9) {
    return 'ms'
  } else {
    return 's'
  }
}
/**
 * Displays a number of nanoseconds as the appropriate unit
 * @param s A number of nanoseconds
 * @param unit A string returned by displayUnits()
 * @returns A string representing s in `unit` units.
 */
function toDisplay(s: number, unit: string): string {
  switch (unit) {
    case 'ns':
      return s.toFixed(2)
    case 'μs':
      return (s / 1000).toFixed(2)
    case 'ms':
      return (s / 1e6).toFixed(2)
    case 's':
      return (s / 1e9).toFixed(2)
    default:
      throw new Error(`Unknown unit ${unit}`)
  }
}

/// If we have a number X which is a P percent change from Y, calculate Y
/// Example: newVal is 60 and pctChange is 50, so oldval must have been 40
function undoPctChange(pctChange: number, newVal: number): number {
  const p = pctChange / 100
  return newVal / (1 + p)
}

/**
 * Represents a single benchmark point: one measurement of one trial. All numbers
 * are in nanoseconds except confidenceLevel which is a number in [0,1) and
 * describes the confidence% of the [lowerBound, upperBound] interval (e.g. 95%)
 */
class MeasurementStats {
  readonly estimate: number
  readonly lower_bound: number
  readonly upper_bound: number
  readonly unit: string

  /** Construct a MeasurementStats from a part of a JSON object */
  constructor(body: any) {
    this.estimate = parseFloat(body!.estimate)
    this.lower_bound = parseFloat(body!.lower_bound)
    this.upper_bound = parseFloat(body!.upper_bound)
    this.unit = body!.unit
  }
}

/**
 * Represents the changes between two benchmark results (output by cargo
 * criterion under the "changes" key)
 */
class BenchmarkChanges {
  mean: MeasurementStats
  median: MeasurementStats
  change: string
  constructor(body: any) {
    core.debug(`Attempting to construct changes from ${body}`)
    this.mean = new MeasurementStats(body!.mean)
    this.median = new MeasurementStats(body!.median)
    this.change = body!.change
  }
}

/**
 * The results and basic statistics from a single Criterion.rs benchmark.
 * Format and name are derived from the coressponding cargo criterion JSON message
 * 
 * Note: we're using the somewhat-hacky assumption that we're looking at the
 * **new** BenchmarkComplete message, even though in principle we could look
 * at either (or both!). This works because we can get all the info we need
 * to out of the new benchmark, but can be a little confusing when talking
 * about certain kinds of information.
 */
class BenchmarkComplete {
  id: string
  report_directory: string
  iteration_count: number[]
  measured_values: number[]
  unit: string
  typical: MeasurementStats
  mean: MeasurementStats
  median: MeasurementStats
  median_abs_dev: MeasurementStats
  slope: MeasurementStats | null
  change: BenchmarkChanges | null

  constructor(body: any) {
    this.id = body.id
    this.report_directory = body.report_directory
    this.iteration_count = body.iteration_count.map((x: string) => parseInt(x))
    this.measured_values = body.measured_values.map((x: string) =>
      parseFloat(x)
    )
    this.unit = body.unit
    this.typical = new MeasurementStats(body.typical)
    this.mean = new MeasurementStats(body.mean)
    this.median = new MeasurementStats(body.median)
    this.median_abs_dev = new MeasurementStats(body.median_abs_dev)
    if (body.slope != null) {
      this.slope = new MeasurementStats(body.slope)
    } else {
      this.slope = null
    }
    if (body.change != null) {
      this.change = new BenchmarkChanges(body.change)
    } else {
      // Probably because this did not show up in both benchmarks
      this.change = null
    }
  }

  isSignificant() {
    if (this.change !== null) {
      return this.change.change !== 'NoChange'
    } else {
      return false
    }
  }

  /// Is this benchmark new in this benchmark set?
  isNew(){
    return this.change === null
  }

  /// Generates a markdown row from the given benchmark result
  generateMarkdownRow(order: ReportFields[]): string {
    let newTimeNano = this.mean.estimate
    let newTimeDisplayUnit = displayUnits(newTimeNano)
    let newTimeDisplay = toDisplay(newTimeNano, newTimeDisplayUnit)
    let pctChange: string, baseTime: string
    if (this.change != null) {
      let pChange = this.change.mean.estimate
      let bTime = undoPctChange(pChange, parseFloat(newTimeDisplay))
      baseTime = bTime.toString() + ' ' + newTimeDisplayUnit
      pctChange = pChange.toFixed(2) + '%'
    } else {
      pctChange = 'null'
      baseTime = 'unknown'
    }
    newTimeDisplay = newTimeDisplay + ' ' + newTimeDisplayUnit

    // Figure out bounds on %change
    let pctLB: string, pctUB: string
    if (pctChange === 'null') {
      pctLB = this.change?.mean.lower_bound.toFixed(2) + '%'
      pctUB = this.change?.mean.upper_bound.toFixed(2) + '%'
    } else {
      pctLB = 'null'
      pctUB = 'null'
    }

    let outMap = new Map([
      [ReportFields.BaseTime, baseTime],
      [ReportFields.PRTime, newTimeDisplay],
      [ReportFields.TestName, this.id],
      [ReportFields.PctDiff, pctChange],
      [ReportFields.PctDiff_LB, pctLB],
      [ReportFields.PctDiff_UB, pctUB]
    ])

    let out = '| '
    order.forEach(x => {
      out += outMap.get(x)
      out += ' | '
    })
    out += ' |'
    return out
  }
}

/**
 * Generates an array of BenchmarkResults by parsing a JSON string, looking for
 * "reason = benchmark-complete".
 * @param s JSON string of results from cargo criterion
 * @returns Array of BenchmarkResults
 */
function resultsFromJSONString(s: string): Array<BenchmarkComplete> {
  let out = new Array()
  const messages = s.trim().split('\n')
  // Ideally this would be a map-filter-map, but we can't catch individual
  // message exceptions like that.
  for (let msg of messages) {
    try {
      const json = JSON.parse(msg)
      if (json.reason == null || json.reason != 'benchmark-complete') {
        continue
      }
      out.push(new BenchmarkComplete(json))
    } catch (e: any) {
      core.error(`Exception while parsing JSON results: ${e}`)
      core.debug(`Input string was ${msg}`)
      core.debug(`Stack trace: ${e.stack}`)
      throw e
    }
  }

  return out
}

/**
 * Generates the first + second rows of a markdown table
 * @param order The order of ReportFields to use in the table
 * @param branchName The name of the base branch
 * @returns A string with the first two rows of markdown
 */
function genMarkdownHeader(order: ReportFields[]): string {
  let outMap = new Map([
    [ReportFields.BaseTime, 'Base'],
    [ReportFields.PRTime, 'PR'],
    [ReportFields.TestName, 'Test Name'],
    [ReportFields.PctDiff, `% Change`],
    [ReportFields.PctDiff_LB, `% Change (Lower)`],
    [ReportFields.PctDiff_UB, `% Change (Upper)`]
  ])
  // Add initial header row
  let output = '|'
  for (let ty of order) {
    output += ' '
    output += outMap.get(ty)!
    output += ' |'
  }
  output += '\n'
  // Add second row
  output += '|'
  for (let _ in order) {
    output += '---|'
  }
  output += '\n'
  return output
}

/**
 * Gets comparison results for
 * @param args Arguments provided to the overall GH Action
 * @returns A string containing the markdown contents of comparison.
 */
export async function genBenchmarkResultTable(
  jsonOutput: string
): Promise<string> {

  let results = resultsFromJSONString(jsonOutput)

  let order = [
    ReportFields.TestName,
    ReportFields.BaseTime,
    ReportFields.PRTime,
    ReportFields.PctDiff,
    ReportFields.PctDiff_LB,
    ReportFields.PctDiff_UB
  ]

  // Build up the table by querying each BenchmarkResult and asking it to generate
  // its own Markdown row.
  let table = genMarkdownHeader(order)
  let insignificant = new Array<String>()
  for (let res of results) {
    if (res.isSignificant() || res.isNew()) {
      table += res.generateMarkdownRow(order)
      table += '\n'
    } else {
      insignificant.push(res.id)
    }
  }
  let insignificantStr = insignificant.join(', ')

  // Build the final post string.
  const context = github.context
  let shortSha = context.sha.slice(0, 7)
  let mdTable = `
## Benchmark for ${shortSha}
<details>
  <summary>Click to view benchmark</summary>

${table}

Tests with no significant difference: ${insignificantStr}

</details>
`
  return mdTable
}
