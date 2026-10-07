import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import { api, postPdf } from '../api'
import { useSelection } from '../selection'
import { inr } from '../bill'

type Defaulter = {
  studentId: number; enrollmentId: number; admissionNo: string; name: string; className: string; overdue: string; totalDue: string
  contacts?: { fatherName?: string; motherName?: string; phone?: string; email?: string; fatherEmail?: string; motherEmail?: string }
}
type Tpl = { id: number; name: string; body: string }
type SmsTpl = { id: number; forType: string; starting: string; content: string; ending: string }
type Notice = { id: number; enrollmentId: number; kind: string; scope: string; dueAmount: string; asOf: string; createdBy: string; createdAt: string }
type SendResult = { sent: number; results: { enrollmentId: number; status: string; reason?: string }[] }

const today = () => new Date().toISOString().slice(0, 10)
const MAX = 500
const HELP = 'Placeholders: {parent} {student} {admissionNo} {class} {due} {since} {date}'

// ponytail: scope only narrows WHO is listed (transport / hostel users); the amount is always their total overdue.
export default function Defaulters() {
  const { schoolId, yearId } = useSelection()
  const [asOf, setAsOf] = useState(today())
  const [standardId, setStandardId] = useState<number>()
  const [sectionId, setSectionId] = useState<number>()
  const [minDue, setMinDue] = useState<number | null>(null)
  const [scope, setScope] = useState('FEE')
  const [standards, setStandards] = useState<{ id: number; name: string; sections: { id: number; name: string }[] }[]>([])
  const [rows, setRows] = useState<Defaulter[]>([])
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<number[]>([])
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [templateId, setTemplateId] = useState<number>()
  const [since, setSince] = useState('')
  const [smsTpls, setSmsTpls] = useState<SmsTpl[]>([])
  const [smsId, setSmsId] = useState<number>()
  const [managing, setManaging] = useState(false)
  const [notices, setNotices] = useState<Notice[] | null>(null)
  const [result, setResult] = useState<SendResult | null>(null)
  const [busy, setBusy] = useState(false)

  const loadTemplates = () => {
    if (!schoolId) return
    api<Tpl[]>(`/defaulter-templates?schoolId=${schoolId}`)
      .then((t) => {
        setTemplates(t)
        setTemplateId((cur) => (t.some((x) => x.id === cur) ? cur : t[0]?.id))
      })
      .catch((e) => message.error(e.message))
  }
  useEffect(() => {
    if (!schoolId) return
    loadTemplates()
    api<typeof standards>(`/standards?schoolId=${schoolId}`).then(setStandards).catch((e) => message.error(e.message))
    api<SmsTpl[]>(`/sms-templates?schoolId=${schoolId}&type=defaulter`)
      .then((t) => {
        setSmsTpls(t)
        setSmsId(t[0]?.id)
      })
      .catch((e) => message.error(e.message))
  }, [schoolId])

  async function load() {
    if (!schoolId || !yearId) return
    const qs = new URLSearchParams({ schoolId: String(schoolId), yearId: String(yearId), asOf, scope, contacts: 'true' })
    if (standardId) qs.set('standardId', String(standardId))
    if (sectionId) qs.set('sectionId', String(sectionId))
    if (minDue) qs.set('minDue', String(minDue))
    setLoading(true)
    try {
      setRows(await api<Defaulter[]>(`/defaulters?${qs}`))
      setPicked([])
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [schoolId, yearId])

  async function print() {
    if (!templateId) return message.warning('Pick or create a letter template first')
    setBusy(true)
    try {
      const r = await postPdf('/defaulters/letters', {
        schoolId, yearId, templateId, asOf, scope, studentIds: picked, ...(since ? { since } : {}),
      })
      message.success(`${r.letters} letter(s) printed${r.skipped ? `, ${r.skipped} skipped (nothing owed now)` : ''}`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function sms() {
    if (!smsId) return message.warning('No defaulter SMS template. Create one under Messaging.')
    setBusy(true)
    try {
      const enrollmentIds = rows.filter((r) => picked.includes(r.studentId)).map((r) => r.enrollmentId)
      setResult(await api<SendResult>('/sms/send', { method: 'POST', body: JSON.stringify({ schoolId, yearId, templateId: smsId, enrollmentIds }) }))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function showNotices() {
    try {
      setNotices(await api<Notice[]>(`/defaulters/notices?schoolId=${schoolId}`))
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const sectionOptions = (standards.find((s) => s.id === standardId)?.sections ?? []).map((s) => ({ value: s.id, label: s.name }))
  const nameOf = (enrollmentId: number) => rows.find((r) => r.enrollmentId === enrollmentId)?.name ?? `enrollment #${enrollmentId}`
  const total = rows.reduce((s, r) => s + Number(r.overdue), 0)

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 150 }} />
        <Select allowClear placeholder="Class" style={{ width: 150 }} value={standardId}
          onChange={(v) => (setStandardId(v), setSectionId(undefined))} options={standards.map((s) => ({ value: s.id, label: s.name }))} />
        <Select allowClear placeholder="Section" style={{ width: 110 }} value={sectionId} onChange={setSectionId} options={sectionOptions} disabled={!standardId} />
        <InputNumber min={0} placeholder="Min due" value={minDue} onChange={setMinDue} />
        <Select style={{ width: 130 }} value={scope} onChange={setScope}
          options={[{ value: 'FEE', label: 'All students' }, { value: 'TRANSPORT', label: 'Transport users' }, { value: 'HOSTEL', label: 'Hostel users' }]} />
        <Button type="primary" onClick={load} loading={loading}>Show</Button>
        <Button onClick={showNotices}>Notices history</Button>
      </Space>

      <Space wrap style={{ marginBottom: 16 }}>
        <Select placeholder="Letter template" style={{ width: 220 }} value={templateId} onChange={setTemplateId}
          options={templates.map((t) => ({ value: t.id, label: t.name }))} />
        <Button onClick={() => setManaging(true)}>Letter templates</Button>
        <Input placeholder="Unpaid since (text)" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 170 }} maxLength={50} />
        <Button type="primary" disabled={!picked.length || picked.length > MAX} loading={busy} onClick={print}>
          Print letters ({picked.length})
        </Button>
        <Select placeholder="SMS template" style={{ width: 200 }} value={smsId} onChange={setSmsId}
          options={smsTpls.map((t) => ({ value: t.id, label: `#${t.id} ${(t.starting + t.content).slice(0, 24)}` }))} />
        <Popconfirm title={`Send SMS reminder to ${picked.length} student(s)?`} disabled={!picked.length} onConfirm={sms}>
          <Button disabled={!picked.length} loading={busy}>SMS reminder</Button>
        </Popconfirm>
      </Space>
      {picked.length > MAX && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`At most ${MAX} students per batch; you selected ${picked.length}.`} />}

      <Table rowKey="studentId" size="small" loading={loading} dataSource={rows} pagination={{ pageSize: 50 }} scroll={{ x: true }}
        rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as number[]), preserveSelectedRowKeys: false }}
        summary={() => <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={4}><b>{rows.length} defaulters</b></Table.Summary.Cell>
          <Table.Summary.Cell index={1}><b>{inr(total.toFixed(2))}</b></Table.Summary.Cell><Table.Summary.Cell index={2} colSpan={4} /></Table.Summary.Row>}
        columns={[
          { title: 'Adm. no', dataIndex: 'admissionNo' },
          { title: 'Name', dataIndex: 'name' },
          { title: 'Class', dataIndex: 'className' },
          { title: 'Father / Mother', render: (_, r) => [r.contacts?.fatherName, r.contacts?.motherName].filter(Boolean).join(' / ') || '-' },
          { title: 'Overdue', dataIndex: 'overdue', align: 'right', render: (v) => inr(v) },
          { title: 'Total due', dataIndex: 'totalDue', align: 'right', render: (v) => inr(v) },
          { title: 'Mobile', render: (_, r) => r.contacts?.phone || '-' },
          { title: 'Email', render: (_, r) => r.contacts?.email || r.contacts?.fatherEmail || r.contacts?.motherEmail || '-' },
        ]} />

      <TemplatesModal open={managing} schoolId={schoolId} rows={templates} onClose={() => setManaging(false)} onChange={loadTemplates} />

      <Modal title="Notices history (last 500)" open={!!notices} onCancel={() => setNotices(null)} footer={null} width={800}>
        <Table rowKey="id" size="small" dataSource={notices ?? []} pagination={{ pageSize: 10 }} scroll={{ x: true }} columns={[
          { title: 'When', dataIndex: 'createdAt', render: (v) => new Date(v).toLocaleString() },
          { title: 'Student', dataIndex: 'enrollmentId', render: nameOf },
          { title: 'Kind', dataIndex: 'kind' },
          { title: 'Scope', dataIndex: 'scope' },
          { title: 'Due', dataIndex: 'dueAmount', align: 'right', render: (v) => inr(v) },
          { title: 'As of', dataIndex: 'asOf', render: (v) => v.slice(0, 10) },
          { title: 'By', dataIndex: 'createdBy' },
        ]} />
      </Modal>

      <Modal title="SMS result" open={!!result} onCancel={() => setResult(null)} footer={null}>
        {result && (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={`${result.sent} sent, ${result.results.length - result.sent} not sent. Sending is a STUB (logged only) unless an SMS provider is configured on the server.`} />
            <Table rowKey="enrollmentId" size="small" pagination={{ pageSize: 8 }} dataSource={result.results.filter((r) => r.status !== 'SENT')} columns={[
              { title: 'Student', dataIndex: 'enrollmentId', render: nameOf },
              { title: 'Status', dataIndex: 'status' },
              { title: 'Reason', dataIndex: 'reason' },
            ]} />
          </>
        )}
      </Modal>
    </>
  )
}

function TemplatesModal({ open, schoolId, rows, onClose, onChange }: {
  open: boolean; schoolId?: number; rows: Tpl[]; onClose: () => void; onChange: () => void
}) {
  const [editing, setEditing] = useState<Tpl | 'new' | null>(null)
  const [form] = Form.useForm()

  function edit(t: Tpl | 'new') {
    form.resetFields()
    if (t !== 'new') form.setFieldsValue(t)
    setEditing(t)
  }
  async function save(v: { name: string; body: string }) {
    try {
      if (editing === 'new') await api('/defaulter-templates', { method: 'POST', body: JSON.stringify({ ...v, schoolId }) })
      else await api(`/defaulter-templates/${(editing as Tpl).id}`, { method: 'PUT', body: JSON.stringify(v) })
      setEditing(null)
      onChange()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  async function del(id: number) {
    try {
      await api(`/defaulter-templates/${id}`, { method: 'DELETE' })
      onChange()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Modal title="Letter templates" open={open} onCancel={onClose} footer={null} width={720}>
      <Button type="primary" onClick={() => edit('new')} style={{ marginBottom: 12 }}>Add template</Button>
      <Table rowKey="id" size="small" pagination={false} dataSource={rows} columns={[
        { title: 'Name', dataIndex: 'name' },
        { title: 'Body', dataIndex: 'body', ellipsis: true },
        { title: '', render: (_, t) => (
          <Space>
            <Button size="small" onClick={() => edit(t)}>Edit</Button>
            <Popconfirm title="Delete this template?" onConfirm={() => del(t.id)}><Button size="small" danger>Delete</Button></Popconfirm>
          </Space>
        ) },
      ]} />
      <Modal title={editing === 'new' ? 'Add template' : 'Edit template'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Name" rules={[{ required: true, max: 100 }]}><Input /></Form.Item>
          <Form.Item name="body" label="Letter body" rules={[{ required: true, min: 10, max: 4000 }]}><Input.TextArea rows={8} /></Form.Item>
          <Typography.Text type="secondary">{HELP}</Typography.Text>
        </Form>
      </Modal>
    </Modal>
  )
}
