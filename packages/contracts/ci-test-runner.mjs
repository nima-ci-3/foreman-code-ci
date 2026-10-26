import { execFileSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { TestRunner } from 'vitest'
import { writeCiProgressEvent } from '../../scripts/ci-progress-reporter.mjs'
import { startFileCoverage, writeFileCoverage } from '../../scripts/integration-coverage.mjs'

export default class CiTestRunner extends TestRunner {
  async onBeforeCollect() {
    const directory = process.env.FOREMAN_CODE_INTEGRATION_COVERAGE_DIRECTORY
    const file = process.env.FOREMAN_CODE_TEST_FILE
    if (!directory || !file) return
    const root = process.env.CI_REPOSITORY_ROOT ?? resolve(this.config.root, '../..')
    const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'))
    this.fileCoverage = { directory, file, root, tracked, stop: await startFileCoverage() }
  }

  async onAfterRunFiles(files) {
    super.onAfterRunFiles(files)
    const coverage = this.fileCoverage
    this.fileCoverage = undefined
    if (!coverage) return
    const { directory, file, root, tracked, stop } = coverage
    // Returned beforeAll cleanups and file fixtures finish after afterAll hooks.
    writeFileCoverage(directory, file, await stop(root, tracked), stop.requiresStatic, stop.functions)
  }

  record(type, task) {
    const names = [task.name]
    for (let suite = task.suite; suite; suite = suite.suite) names.unshift(suite.name)
    writeCiProgressEvent(type, {
      id: task.id, kind: 'test', name: names.join(' > '),
      file: relative(process.env.CI_REPOSITORY_ROOT ?? this.config.root, task.file.filepath).replaceAll('\\', '/'),
    })
  }

  async onBeforeRunTask(task) {
    await super.onBeforeRunTask(task)
    // Vitest batches IPC updates; a synchronous loop prevents the reporter from receiving its ready event.
    if (task.mode === 'run' || task.mode === 'queued') this.record('start', task)
  }

  onAfterRunTask(task) {
    super.onAfterRunTask(task)
    this.record('finish', task)
  }
}
