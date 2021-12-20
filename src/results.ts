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
 * To this end, we parse the benchmark results from critcmp as JSON, turning
 * them into BenchmarkResults. We then pair off BenchmarkResults into 
 * BenchmarkComparisons. Each BenchmarkComparison has enough information
 * to generate a single row of this table.
 */

import * as core from '@actions/core'
import * as github from '@actions/github'
import { ActionArguments } from './arguments'
import { execCapture } from './util'

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

/** The fields we output into the final markdown report. */
enum ReportFields {
  name,
  deltaRes,
  baseRes,
  pctDiff
}

/**
 * Represents a single benchmark point: one measurement of one trial. All numbers
 * are in nanoseconds except confidenceLevel which is a number in [0,1) and
 * describes the confidence% of the [lowerBound, upperBound] interval (e.g. 95%)
 */
class MeasurementStats {
  readonly kind: string
  readonly pointEstimate: number
  readonly standardError: number
  readonly lowerBound: number
  readonly upperBound: number
  readonly confidenceLevel: number

  /** Construct a MeasurementStats from a part of a JSON object */
  constructor(name: string, body: any) {
    this.kind = name

    /* These two entries are currently crucial to statistics computation--without
       them, we cannot compute stats. The rest are just nice-to-haves. */
    if (typeof body.point_estimate !== 'number') {
      core.error(
        "No 'point_estimate' found in JSON--has critcmp format changed?"
      )
    }
    if (typeof body.standard_error !== 'number') {
      core.error(
        "No 'standard_error' found in JSON--has critcmp format changed?"
      )
    }

    this.pointEstimate = body.point_estimate
    this.standardError = body.standard_error

    if (this.pointEstimate < 1 || this.standardError < 1) {
      core.warning(
        `Found a value of ${this.pointEstimate}±${this.standardError}. This value is highly suspicious!!`
      )
    }

    // Default values: confidence level and bounds are set assuming pointEstimate
    // is the only valid estimate (so it's lower and upper bound with no confidence)
    const CI = body.confidence_interval ?? {
      lower_bound: this.pointEstimate,
      upper_bound: this.pointEstimate,
      confidence_level: 0.0
    }
    this.lowerBound = CI.lower_bound ?? this.pointEstimate
    this.upperBound = CI.upper_bound ?? this.pointEstimate
    this.confidenceLevel = CI.confidence_level ?? 0.0
  }
}

/**
 * Represents a benchmark result on a given object and dataset (e.g. the results
 * of running "test_five_random" on "main"). Contains
 */
class BenchmarkResult {
  name: string // Name of the benchmark (e.g. "run_db_query")
  baseline: string // Name of the baseline that this result belongs to
  mean: MeasurementStats
  median: MeasurementStats
  std_dev: MeasurementStats

  constructor(name: string, benchmark_obj: any) {
    if (benchmark_obj == null) {
      core.error(`Received a null/undef object for ${name}`)
    }

    this.name = name
    this.baseline = benchmark_obj.baseline ?? 'unknown'

    const estimates = benchmark_obj.criterion_estimates_v1
    if (estimates == null) {
      core.error('Criterion estimates not found. Has data format changed?')
      throw new Error('Benchmark data not found in benchmark object')
    }
    if (estimates.mean == null) {
      core.error(`Mean was not found in benchmark ${name}: ${benchmark_obj}`)
      throw new Error('Benchmark data not found in benchmark object')
    } else {
      this.mean = new MeasurementStats('mean', estimates.mean)
    }

    if (estimates.median == null) {
      core.error(`Median was not found in benchmark ${name}: ${benchmark_obj}`)
      throw new Error('Benchmark data not found in benchmark object')
    } else {
      this.median = new MeasurementStats('median', estimates.median)
    }

    if (estimates.std_dev == null) {
      core.error(`std_dev was not found in benchmark ${name}: ${benchmark_obj}`)
      throw new Error('Benchmark data not found in benchmark object')
    } else {
      this.std_dev = new MeasurementStats('std_dev', estimates.std_dev)
    }
  }

  /** Determines if the difference between this benchmark and the other is significant */
  diffSignificant(other: BenchmarkResult): boolean {
    if (other.name !== this.name) {
      core.warning(`Tried to compare names ${other.name} and ${this.name}.`)
      return false
    }
    let myVal = this.mean.pointEstimate
    let myErr = this.std_dev.pointEstimate
    let oVal = other.mean.pointEstimate
    let oErr = other.std_dev.pointEstimate

    /* The following code is adapted from the original criterion-compare-action
       repository. I'm unsure if this is statistically valid or meaningful, but
       I'm retaining it for now. */
    if (myVal < oVal) {
      return myVal + myErr < oVal || oVal - oErr > myVal
    } else {
      return myVal - myErr > oVal || oVal + oErr < myVal
    }
  }
}

/** A comparison of two individual benchmark results against each other */
class BenchmarkComparison {
  name: string
  benchBase: BenchmarkResult
  benchDelta: BenchmarkResult
  isSignificant: boolean
  pctDiff: number

  constructor(base: BenchmarkResult, delta: BenchmarkResult) {
    if (base.name !== delta.name) {
      throw new Error('Trying to compare benchmarks with different names')
    }
    this.name = base.name
    this.benchBase = base
    this.benchDelta = delta
    this.isSignificant = base.diffSignificant(delta)
    this.pctDiff =
      (100 * (delta.mean.pointEstimate - base.mean.pointEstimate)) /
      base.mean.pointEstimate
  }

  /**
   * Gets the string representation of a field in the Markdown table
   * @param ty The type of field requested
   * @param addBold Whether the element should be **bolded**
   * @returns A markdown string representation of the appropriate field
   */
  getMarkdownElement(ty: ReportFields, addBold: boolean): string {
    let term: string
    let unit: string

    switch (ty) {
      case ReportFields.name:
        term = this.benchBase.name
        break
      case ReportFields.deltaRes:
        unit = displayUnits(this.benchDelta.mean.pointEstimate)
        term =
          toDisplay(this.benchDelta.mean.pointEstimate, unit) +
          ' ± ' +
          toDisplay(this.benchDelta.std_dev.pointEstimate, unit) +
          ' ' +
          unit
        break
      case ReportFields.baseRes:
        unit = displayUnits(this.benchBase.mean.pointEstimate)
        term =
          toDisplay(this.benchBase.mean.pointEstimate, unit) +
          ' ± ' +
          toDisplay(this.benchBase.std_dev.pointEstimate, unit) +
          ' ' +
          unit
        break
      case ReportFields.pctDiff:
        term = Math.round(this.pctDiff).toString()
        break
      default:
        throw new Error(`Unknown ReportField type ${ty}`)
    }
    if (addBold) {
      return '**' + term + '**'
    } else {
      return term
    }
  }

  /**
   * Generates a row of the markdown report table given the column names in-order.
   * @param columnNames The column names in the order used in the table.
   * @param useBold Whether to bold the faster field of (delta, base)
   * @returns A markdown string for a single row of the table.
   */
  generateMarkdownTableRow(
    columnNames: ReportFields[],
    useBold: boolean
  ): string {
    let output = '|'
    let boldField = null
    if (useBold) {
      if (this.pctDiff > 100) {
        boldField = ReportFields.deltaRes
      } else {
        boldField = ReportFields.baseRes
      }
    }

    for (let ty of columnNames) {
      output += ' '
      if (ty == boldField) {
        output += this.getMarkdownElement(ty, true)
      } else {
        output += this.getMarkdownElement(ty, false)
      }
      output += ' |'
    }
    return output
  }
}

/**
 * Generates an array of BenchmarkResults by parsing a JSON string
 * @param s JSON string from critcmp
 * @returns Array of BenchmarkResults
 */
function resultsFromJSONString(s: string): Array<BenchmarkResult> {
  try {
    let toplevel = JSON.parse(s)
    if (toplevel.benchmarks == null) {
      console.error(
        "No 'benchmarks' key found in JSON: has data format changed?"
      )
    }

    let out = new Array<BenchmarkResult>()
    for (const [name, value] of Object.entries(toplevel.benchmarks)) {
      out.push(new BenchmarkResult(name, value))
    }
    return out
  } catch (e) {
    core.error(`Exception while parsing JSON results: ${e}`)
    throw e
  }
}

/**
 * Converts two BenchmarkResults (base + delta) into a list of BenchmarkComparisons
 * by pairing off the tests with matching names
 * @param baseResults Results from the base branch
 * @param deltaResults Results from the test (PR) branch
 * @returns A tuple with three elements:
 *  - [0]: A list of BenchmarkResults
 *  - [1]: A list of test names that were in base, but not the PR
 *  - [2]: A list of test names that were in the PR, but not in base
 */
function processResults(
  baseResults: BenchmarkResult[],
  deltaResults: BenchmarkResult[]
): [BenchmarkComparison[], Set<string>, Set<string>] {
  let allTestNames = new Set<string>()
  let baseDict = new Map<string, BenchmarkResult>()
  let deltaDict = new Map<string, BenchmarkResult>()
  baseResults.forEach(x => {
    baseDict.set(x.name, x)
    allTestNames.add(x.name)
  })
  deltaResults.forEach(x => {
    deltaDict.set(x.name, x)
    allTestNames.add(x.name)
  })

  let compareResults = new Array<BenchmarkComparison>()
  let inBaseOnly = new Set<string>()
  let inDeltaOnly = new Set<string>()

  for (let name of allTestNames) {
    let baseRes = baseDict.get(name)
    let deltaRes = deltaDict.get(name)
    if (baseRes != null && deltaRes != null) {
      compareResults.push(new BenchmarkComparison(baseRes, deltaRes))
    } else if (baseRes == null) {
      inDeltaOnly.add(name)
    } else if (deltaRes == null) {
      inBaseOnly.add(name)
    } else {
      core.error('Unreachable executed in processResults')
    }
  }
  return [compareResults, inBaseOnly, inDeltaOnly]
}

/**
 * Generates the first + second rows of a markdown table
 * @param order The order of ReportFields to use in the table
 * @param branchName The name of the base branch
 * @returns A string with the first two rows of markdown
 */
function genMarkdownHeader(order: ReportFields[], branchName: string): string {
  let outMap = new Map([
    [ReportFields.baseRes, branchName],
    [ReportFields.deltaRes, 'PR'],
    [ReportFields.name, 'Test Name'],
    [ReportFields.pctDiff, `% of ${branchName}`]
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
export async function runComparison(args: ActionArguments): Promise<[BenchmarkComparison[], string]> {
  let result1 = await execCapture('critcmp', ['--export', 'base'], args.workDir)
  let result2 = await execCapture(
    'critcmp',
    ['--export', 'changes'],
    args.workDir
  )

  const baseResults = resultsFromJSONString(result1.stdOut)
  const changeResults = resultsFromJSONString(result2.stdOut)

  let results = processResults(baseResults, changeResults)

  let order = [
    ReportFields.name,
    ReportFields.deltaRes,
    ReportFields.baseRes,
    ReportFields.pctDiff
  ]

  // Build up the table by querying each BenchmarkResult and asking it to generate
  // its own Markdown row.
  let table = genMarkdownHeader(order, args.branchName)
  let insignificant = new Array<String>()
  for (let res of results[0]) {
    if (res.isSignificant) {
      table += res.generateMarkdownTableRow(order, true)
      table += '\n'
    } else {
      insignificant.push(res.name)
    }
  }
  let insignificantStr = insignificant.join(', ')

  /* There can be benchmarks that are not in both sets (e.g. benchmarks added
    or removed in the PR). We can't report differences for them, but we should
    note that the benchmark set has changed.   */
  let otherResults = ''
  if (results[1].size > 0) {
    otherResults += `\n Tests only on ${args.branchName}: `
    otherResults += Array.from(results[1]).join(', ')
  }
  if (results[2].size > 0) {
    otherResults += `\n Tests only on PR: `
    otherResults += Array.from(results[2]).join(', ')
  }

  // Build the final post string.
  const context = github.context
  let shortSha = context.sha.slice(0, 7)
  let mdTable = `
## Benchmark for ${shortSha}
<details>
  <summary>Click to view benchmark</summary>

${table}

Tests with no significant difference: ${insignificantStr}

${otherResults}
</details>
`
  return [results[0], mdTable]
}
