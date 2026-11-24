// 无头 CLI 模拟：最后一个参数视为 prompt，前面的参数回显在 ARGS: 行中。
// 输出混合 JSON 行与一行纯文本，用于验证 process Adapter 的逐行解析。
const args = process.argv.slice(2)
const prompt = args.at(-1) ?? ''
const before = args.slice(0, -1)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

process.stdout.write(`${JSON.stringify({ type: 'text', content: `ARGS:${before.join('|')}\n` })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'assistant', text: `ECHO:${prompt}\n` })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'result', content: ':DONE' })}\n`)
process.stdout.write('plain-text-line\n')

if (prompt.includes('SLOW')) {
  await delay(5000)
  process.stdout.write(`${JSON.stringify({ type: 'result', content: 'LATE' })}\n`)
} else {
  process.stderr.write(`${JSON.stringify({ type: 'text', content: 'STDERR-DELTA\n' })}\n`)
}
