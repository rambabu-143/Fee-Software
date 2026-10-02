import { Button, Empty, InputNumber, Select, Space, Table, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'
import type { Installment } from './Installments'

type FeeHead = { id: number; name: string; type: string }
type Cell = { feeHeadId: number; installmentId: number; amount: string }
const key = (h: number, i: number) => `${h}:${i}`
const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Grid for one class: rows = fee heads, columns = installments.
export default function FeeStructure() {
  const { schoolId, yearId } = useSelection()
  const [standards, setStandards] = useState<{ id: number; name: string }[]>([])
  const [standardId, setStandardId] = useState<number>()
  const [heads, setHeads] = useState<FeeHead[]>([])
  const [insts, setInsts] = useState<Installment[]>([])
  const [amounts, setAmounts] = useState<Record<string, number>>({})
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!schoolId || !yearId) return
    Promise.all([
      api<{ id: number; name: string }[]>(`/standards?schoolId=${schoolId}`),
      api<FeeHead[]>(`/fee-heads?schoolId=${schoolId}`),
      api<Installment[]>(`/installments?schoolId=${schoolId}&yearId=${yearId}`),
    ])
      .then(([s, h, i]) => {
        setStandards(s)
        setHeads(h)
        setInsts(i)
        setStandardId((cur) => (s.some((x) => x.id === cur) ? cur : s[0]?.id))
      })
      .catch((e) => message.error(e.message))
  }, [schoolId, yearId])

  const fill = (cells: Cell[]) => {
    setAmounts(Object.fromEntries(cells.map((c) => [key(c.feeHeadId, c.installmentId), Number(c.amount)])))
    setDirty(false)
  }

  useEffect(() => {
    if (standardId && yearId) {
      api<Cell[]>(`/fee-structure?yearId=${yearId}&standardId=${standardId}`).then(fill).catch((e) => message.error(e.message))
    }
  }, [standardId, yearId])

  async function save() {
    const items = Object.entries(amounts)
      .filter(([, amount]) => amount > 0)
      .map(([k, amount]) => {
        const [feeHeadId, installmentId] = k.split(':').map(Number)
        return { feeHeadId, installmentId, amount }
      })
    try {
      fill(await api<Cell[]>('/fee-structure', { method: 'PUT', body: JSON.stringify({ yearId, standardId, items }) }))
      message.success('Fee structure saved')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const amt = (h: number, i: number) => amounts[key(h, i)] ?? 0
  const rowTotal = (h: number) => insts.reduce((s, i) => s + amt(h, i.id), 0)
  const colTotal = (i: number) => heads.reduce((s, h) => s + amt(h.id, i), 0)

  if (!heads.length || !insts.length) {
    return <Empty description="Add fee heads and installments for this school and year first" />
  }

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <span>Class:</span>
        <Select style={{ minWidth: 160 }} value={standardId} onChange={setStandardId}
          options={standards.map((s) => ({ value: s.id, label: s.name }))} />
        <Button type="primary" onClick={save} disabled={!dirty}>Save</Button>
      </Space>
      <Table rowKey="id" dataSource={heads} pagination={false} scroll={{ x: true }} bordered
        columns={[
          { title: 'Fee head', dataIndex: 'name', fixed: 'left' },
          ...insts.map((i) => ({
            title: i.label,
            key: i.id,
            render: (_: unknown, h: FeeHead) => (
              <InputNumber min={0} precision={2} style={{ width: 120 }} value={amt(h.id, i.id) || null}
                onChange={(v) => {
                  setAmounts((a) => ({ ...a, [key(h.id, i.id)]: v ?? 0 }))
                  setDirty(true)
                }} />
            ),
          })),
          { title: 'Total', key: 'total', align: 'right' as const, render: (_: unknown, h: FeeHead) => money(rowTotal(h.id)) },
        ]}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}><Typography.Text strong>Total</Typography.Text></Table.Summary.Cell>
            {insts.map((i, n) => (
              <Table.Summary.Cell key={i.id} index={n + 1}><Typography.Text strong>{money(colTotal(i.id))}</Typography.Text></Table.Summary.Cell>
            ))}
            <Table.Summary.Cell index={insts.length + 1} align="right">
              <Typography.Text strong>{money(heads.reduce((s, h) => s + rowTotal(h.id), 0))}</Typography.Text>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
    </>
  )
}
