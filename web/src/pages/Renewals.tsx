import { Alert, Button, Card, Form, Modal, Popconfirm, Select, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Gate } from '../session'
import { useSelection } from '../selection'
import { qs, useRoster } from '../moneyShared'

type Row = { id: number; type: 'RENEW' | 'WITHDRAW'; status: 'PENDING' | 'APPLIED' | 'SKIPPED'; note: string | null; filledBy: string; student: { admissionNo: string; name: string }; className: string }
type Applied = { applied: number; skipped: number; rows: { id: number; status: string; note: string | null }[] }

const tone = { PENDING: 'gold', APPLIED: 'green', SKIPPED: 'default' } as const

// Yearly transport opt-in / opt-out, applied to next year's enrollments at year end.
export default function Renewals() {
  const { schoolId, yearId, years } = useSelection()
  const { options, enrollmentIdOf } = useRoster()
  const [rows, setRows] = useState<Row[]>([])
  const [status, setStatus] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [toYearId, setToYearId] = useState<number>()
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<Applied | null>(null)
  const [snap, setSnap] = useState<Row[]>([])
  const [form] = Form.useForm()

  const load = () => (schoolId && yearId ? api<Row[]>(`/transport-renewals?${qs({ schoolId, yearId, status })}`).then(setRows).catch((e) => message.error(e.message)) : undefined)
  useEffect(() => {
    load()
  }, [schoolId, yearId, status])

  // Default "apply into" = the earliest year starting after the selected one.
  useEffect(() => {
    const cur = years.find((y) => y.id === yearId)
    setToYearId(years.filter((y) => cur && y.startDate > cur.startDate).sort((a, b) => a.startDate.localeCompare(b.startDate))[0]?.id)
    setApplied(null)
  }, [years, yearId])

  async function add(v: { studentId: number; type: string }) {
    try {
      await api('/transport-renewals', { method: 'POST', body: JSON.stringify({ enrollmentId: enrollmentIdOf(v.studentId), type: v.type }) })
      setAdding(false)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  async function apply() {
    setApplying(true)
    setSnap(rows) // the list reloads (and may filter) after applying; keep names for the outcome table
    try {
      setApplied(await api<Applied>('/transport-renewals/apply', { method: 'POST', body: JSON.stringify({ schoolId, fromYearId: yearId, toYearId }) }))
      await load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setApplying(false)
    }
  }

  const who = (id: number) => snap.find((r) => r.id === id)
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card size="small" title="Apply to next year">
        <Space wrap>
          Apply pending decisions into
          <Select style={{ width: 140 }} value={toYearId} onChange={setToYearId} placeholder="Year" options={years.filter((y) => y.id !== yearId).map((y) => ({ value: y.id, label: y.label }))} />
          <Gate cap="renewals.admin"><Popconfirm title="Apply every pending renewal?" description="Renew copies the transport stops; withdraw stops them. Safe to repeat." onConfirm={apply}>
            <Button type="primary" loading={applying} disabled={!toYearId}>Apply</Button>
          </Popconfirm></Gate>
        </Space>
        {applied && (
          <div style={{ marginTop: 12 }}>
            <Alert type="success" showIcon message={`${applied.applied} applied, ${applied.skipped} skipped`} style={{ marginBottom: 8 }} />
            <Table rowKey="id" size="small" pagination={false} dataSource={applied.rows} columns={[
              { title: 'Student', render: (_, r) => (who(r.id) ? `${who(r.id)!.student.name} (${who(r.id)!.student.admissionNo})` : `#${r.id}`) },
              { title: 'Type', render: (_, r) => who(r.id)?.type },
              { title: 'Outcome', dataIndex: 'status', render: (v: keyof typeof tone) => <Tag color={tone[v]}>{v}</Tag> },
              { title: 'Note', dataIndex: 'note' },
            ]} />
          </div>
        )}
      </Card>

      <Space wrap>
        <Select allowClear placeholder="Status" style={{ width: 140 }} onChange={setStatus} options={['PENDING', 'APPLIED', 'SKIPPED'].map((s) => ({ value: s, label: s }))} />
        <Button type="primary" onClick={() => { form.resetFields(); form.setFieldsValue({ type: 'RENEW' }); setAdding(true) }}>Add decision</Button>
        <span>{rows.length} decisions</span>
      </Space>
      <Table rowKey="id" dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 25 }} columns={[
        { title: 'Adm. no.', render: (_, r) => r.student.admissionNo },
        { title: 'Student', render: (_, r) => r.student.name },
        { title: 'Class', dataIndex: 'className' },
        { title: 'Decision', dataIndex: 'type', render: (v: string) => <Tag color={v === 'RENEW' ? 'blue' : 'orange'}>{v}</Tag> },
        { title: 'Status', dataIndex: 'status', render: (v: keyof typeof tone) => <Tag color={tone[v]}>{v}</Tag> },
        { title: 'Note', dataIndex: 'note' },
        { title: 'Entered by', dataIndex: 'filledBy' },
        // ponytail: shown to all; the API allows only ADMIN to delete and returns 403 otherwise.
        { title: '', render: (_, r) => r.status !== 'APPLIED' && (
          <Gate cap="renewals.admin" hide><Popconfirm title="Remove this decision?" onConfirm={() => api(`/transport-renewals/${r.id}`, { method: 'DELETE' }).then(load).catch((e) => message.error(e.message))}>
            <Button size="small" danger>Remove</Button>
          </Popconfirm></Gate>
        ) },
      ]} />

      <Modal title="Transport decision" open={adding} onCancel={() => setAdding(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={add}>
          <Form.Item name="studentId" label="Student (must have transport this year)" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={options} placeholder="Search student" />
          </Form.Item>
          <Form.Item name="type" label="Decision" rules={[{ required: true }]}>
            <Select options={[{ value: 'RENEW', label: 'Renew (keep transport next year)' }, { value: 'WITHDRAW', label: 'Withdraw (stop transport)' }]} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
