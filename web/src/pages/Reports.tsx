import { Button, Input, Select, Space, Table, Tabs, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'
import { inr } from '../bill'
import { downloadCsv } from '../csv'

type Due = {
  studentId: number; admissionNo: string; name: string; active: boolean; className: string
  standardId: number; standard: string; sortOrder: number
  charges: string; fine: string; paid: string; due: string; overdue: string
}
type Coll = { date: string; mode: string; receipts: number; amount: string }

const today = () => new Date().toISOString().slice(0, 10)
const sum = <T,>(rows: T[], f: (r: T) => string | number) => rows.reduce((s, r) => s + Number(f(r)), 0)
const money = (n: number) => inr(n.toFixed(2))

export default function Reports() {
  const { schoolId, yearId } = useSelection()
  const [asOf, setAsOf] = useState(today())
  const [rows, setRows] = useState<Due[]>([])
  const [standardId, setStandardId] = useState<number>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!schoolId || !yearId || !asOf) return
    setLoading(true)
    api<Due[]>(`/reports/dues?schoolId=${schoolId}&yearId=${yearId}&asOf=${asOf}`)
      .then(setRows).catch((e) => message.error(e.message)).finally(() => setLoading(false))
  }, [schoolId, yearId, asOf])

  const classes = useMemo(() => {
    const m = new Map<number, Due[]>()
    rows.forEach((r) => m.set(r.standardId, [...(m.get(r.standardId) ?? []), r]))
    return [...m.values()].map((rs) => ({
      standardId: rs[0].standardId, standard: rs[0].standard, students: rs.length,
      charges: sum(rs, (r) => r.charges), fine: sum(rs, (r) => r.fine), paid: sum(rs, (r) => r.paid),
      due: sum(rs, (r) => r.due), overdue: sum(rs, (r) => r.overdue),
      defaulters: rs.filter((r) => Number(r.overdue) > 0).length,
    }))
  }, [rows])

  const defaulters = rows
    .filter((r) => Number(r.overdue) > 0 && (!standardId || r.standardId === standardId))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue))

  const dateInput = <>As of <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 160 }} /></>

  return (
    <Tabs items={[
      {
        key: 'defaulters', label: 'Defaulters', children: (
          <>
            <Space wrap style={{ marginBottom: 16 }}>
              {dateInput}
              <Select allowClear placeholder="All classes" style={{ width: 160 }} value={standardId} onChange={setStandardId}
                options={classes.map((c) => ({ value: c.standardId, label: c.standard }))} />
              <span>{defaulters.length} students · overdue <b>{money(sum(defaulters, (r) => r.overdue))}</b></span>
              <Button onClick={() => downloadCsv(`defaulters-${asOf}`, ['Adm. no.', 'Name', 'Class', 'Overdue', 'Fine', 'Total due', 'Active'],
                defaulters.map((r) => [r.admissionNo, r.name, r.className, r.overdue, r.fine, r.due, r.active ? 'yes' : 'no']))}>CSV</Button>
            </Space>
            <Table rowKey="studentId" loading={loading} dataSource={defaulters} size="small" scroll={{ x: true }} pagination={{ pageSize: 50 }} columns={[
              { title: 'Adm. no.', dataIndex: 'admissionNo' },
              { title: 'Name', dataIndex: 'name', render: (v: string, r) => (r.active ? v : <Typography.Text type="secondary">{v} (inactive)</Typography.Text>) },
              { title: 'Class', dataIndex: 'className' },
              { title: 'Overdue', dataIndex: 'overdue', align: 'right', render: (v: string) => <b>{inr(v)}</b> },
              { title: 'Fine incl.', dataIndex: 'fine', align: 'right', render: inr },
              { title: 'Total due (incl. upcoming)', dataIndex: 'due', align: 'right', render: inr },
            ]} />
          </>
        ),
      },
      {
        key: 'classes', label: 'Class summary', children: (
          <>
            <Space wrap style={{ marginBottom: 16 }}>
              {dateInput}
              <Button onClick={() => downloadCsv(`class-summary-${asOf}`, ['Class', 'Students', 'Charges', 'Fine', 'Collected', 'Overdue', 'Total due', 'Defaulters'],
                classes.map((c) => [c.standard, c.students, c.charges.toFixed(2), c.fine.toFixed(2), c.paid.toFixed(2), c.overdue.toFixed(2), c.due.toFixed(2), c.defaulters]))}>CSV</Button>
            </Space>
            <Table rowKey="standardId" loading={loading} dataSource={classes} size="small" scroll={{ x: true }} pagination={false}
              columns={[
                { title: 'Class', dataIndex: 'standard' },
                { title: 'Students', dataIndex: 'students', align: 'right' },
                { title: 'Charges', dataIndex: 'charges', align: 'right', render: money },
                { title: 'Fine', dataIndex: 'fine', align: 'right', render: money },
                { title: 'Collected', dataIndex: 'paid', align: 'right', render: money },
                { title: 'Overdue', dataIndex: 'overdue', align: 'right', render: (v: number) => <b>{money(v)}</b> },
                { title: 'Total due', dataIndex: 'due', align: 'right', render: money },
                { title: 'Defaulters', dataIndex: 'defaulters', align: 'right' },
              ]}
              summary={() => (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}><b>Total</b></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">{sum(classes, (c) => c.students)}</Table.Summary.Cell>
                  {(['charges', 'fine', 'paid', 'overdue', 'due'] as const).map((k, i) => (
                    <Table.Summary.Cell key={k} index={i + 2} align="right"><b>{money(sum(classes, (c) => c[k]))}</b></Table.Summary.Cell>
                  ))}
                  <Table.Summary.Cell index={7} align="right">{sum(classes, (c) => c.defaulters)}</Table.Summary.Cell>
                </Table.Summary.Row>
              )} />
          </>
        ),
      },
      { key: 'collection', label: 'Daily collection', children: <Collection /> },
    ]} />
  )
}

function Collection() {
  const { schoolId, yearId } = useSelection()
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() })
  const [rows, setRows] = useState<Coll[]>([])

  useEffect(() => {
    if (!schoolId || !yearId) return
    const qs = new URLSearchParams({ schoolId: String(schoolId), yearId: String(yearId) })
    if (range.from) qs.set('from', range.from)
    if (range.to) qs.set('to', range.to)
    api<Coll[]>(`/reports/collection?${qs}`).then(setRows).catch((e) => message.error(e.message))
  }, [schoolId, yearId, range])

  // Pivot: one row per date, one column per payment mode seen.
  const modes = [...new Set(rows.map((r) => r.mode))].sort()
  const days = [...new Set(rows.map((r) => r.date))].map((date) => {
    const rs = rows.filter((r) => r.date === date)
    return {
      date, receipts: sum(rs, (r) => r.receipts), total: sum(rs, (r) => r.amount),
      ...Object.fromEntries(modes.map((m) => [m, sum(rs.filter((r) => r.mode === m), (r) => r.amount)])),
    } as { date: string; receipts: number; total: number } & Record<string, number>
  })

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        From <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 160 }} />
        To <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 160 }} />
        <span>{sum(days, (d) => d.receipts)} receipts · <b>{money(sum(days, (d) => d.total))}</b></span>
        <Button onClick={() => downloadCsv(`collection-${range.from}-to-${range.to}`, ['Date', ...modes, 'Total', 'Receipts'],
          days.map((d) => [d.date, ...modes.map((m) => d[m].toFixed(2)), d.total.toFixed(2), d.receipts]))}>CSV</Button>
      </Space>
      <Table rowKey="date" dataSource={days} size="small" scroll={{ x: true }} pagination={false}
        columns={[
          { title: 'Date', dataIndex: 'date' },
          ...modes.map((m) => ({ title: m.replace('_', ' '), dataIndex: m, align: 'right' as const, render: (v: number) => (v ? money(v) : '–') })),
          { title: 'Total', dataIndex: 'total', align: 'right', render: (v: number) => <b>{money(v)}</b> },
          { title: 'Receipts', dataIndex: 'receipts', align: 'right' },
        ]}
        summary={() => days.length > 0 && (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}><b>Total</b></Table.Summary.Cell>
            {modes.map((m, i) => <Table.Summary.Cell key={m} index={i + 1} align="right"><b>{money(sum(days, (d) => d[m]))}</b></Table.Summary.Cell>)}
            <Table.Summary.Cell index={modes.length + 1} align="right"><b>{money(sum(days, (d) => d.total))}</b></Table.Summary.Cell>
            <Table.Summary.Cell index={modes.length + 2} align="right">{sum(days, (d) => d.receipts)}</Table.Summary.Cell>
          </Table.Summary.Row>
        )} />
    </>
  )
}
