// Optional real-compiler gate: GHDL=/path/to/ghdl npx vitest run src/renderer/src/vhdl
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { isBusType, isNBitType } from '../model/partDefinitions'
import { ComponentType, LogicValue } from '../model/types'
import { CircuitBuilder } from '../sim/__tests__/harness'
import { generateVhdl, type VhdlFiles } from './export'

describe.skipIf(!process.env.GHDL)('VHDL compiler validation', () => {
  function withCompiler(files: VhdlFiles, check: (run: (...args: string[]) => void, dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'simuaid-vhdl-'))
    const run = (...args: string[]): void => {
      execFileSync(process.env.GHDL!, args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    }
    try {
      for (const pkg of files.packages) writeFileSync(join(dir, pkg.name), pkg.contents)
      writeFileSync(join(dir, files.entityFileName), files.entity)
      run('-a', '--std=08', ...files.packages.map((p) => p.name), files.entityFileName)
      check(run, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.each(['synth', 'sim'] as const)('analyzes every supported fixed-width component (%s)', (mode) => {
    const b = new CircuitBuilder()
    for (const type of Object.values(ComponentType)) {
      if (isBusType(type) || isNBitType(type) || type === ComponentType.STATE_MACHINE || type === ComponentType.CHECKER) continue
      b.add(type, type, { label: `device_${type}` })
    }
    withCompiler(generateVhdl(b.netlist, 'all_parts', mode), () => {})
  })

  it('simulates shared-net input/probe connectivity with an independent VHDL testbench', () => {
    const b = new CircuitBuilder()
      .switch('sw', LogicValue.ZERO, { label: 'A' })
      .probe('p1', { label: 'Y' })
      .probe('p2', { label: 'Z' })
      .connect('sw#out', 'p1#in', 'p2#in')
    withCompiler(generateVhdl(b.netlist, 'passthrough', 'synth'), (run, dir) => {
      writeFileSync(join(dir, 'tb.vhd'), `
library ieee;
use ieee.std_logic_1164.all;
entity tb is end tb;
architecture test of tb is
  signal a : std_logic := '0';
  signal y, z : std_logic;
begin
  dut: entity work.passthrough port map (A => a, Y => y, Z => z);
  process
  begin
    wait for 1 ns;
    assert y = '0' and z = '0' report "zero not propagated to both outputs" severity failure;
    a <= '1';
    wait for 1 ns;
    assert y = '1' and z = '1' report "one not propagated to both outputs" severity failure;
    a <= 'X';
    wait for 1 ns;
    assert y = 'X' and z = 'X' report "unknown not propagated to both outputs" severity failure;
    wait;
  end process;
end test;
`)
      run('-a', '--std=08', 'tb.vhd')
      run('-e', '--std=08', 'tb')
      run('-r', '--std=08', 'tb', '--assert-level=error', '--stop-time=4ns')
    })
  })
})
