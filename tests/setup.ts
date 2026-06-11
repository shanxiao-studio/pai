import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll } from 'vitest'

const paiDataHome = join(tmpdir(), `pai-test-data-${process.pid}`)
process.env.PAI_DATA_HOME = paiDataHome

afterAll(() => {
  rmSync(paiDataHome, { recursive: true, force: true })
})
