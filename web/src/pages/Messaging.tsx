import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type Row = Record<string, any> & { id: number }
type Field = { name: string; label: string; area?: boolean; required?: boolean; options?: string[] }
type Recipient = { enrollmentId: number; studentId: number; admissionNo: string; name: string; className: string; overdue: string; contacts?: { phone?: string; email?: string; fatherEmail?: string; motherEmail?: string } }
type SendResult = { sent: number; results: { enrollmentId: number; status: string; sent?: number; reason?: string }[] }

const HELP = 'Placeholders: {name} {admNo} {due} {lastDate}'

// Everything that differs between the SMS and Email tabs lives here.
const KINDS = {
  sms: {
    tpl: '/sms-templates', send: '/sms/send', log: '/sms/log', help: `${HELP}. Message = starting + content + ending.`,
    fields: [
      { name: 'forType', label: 'Type', required: true, options: ['defaulter', 'receipt', 'general'] },
      { name: 'starting', label: 'Starting text' },
      { name: 'content', label: 'Content', area: true, required: true },
      { name: 'ending', label: 'Ending text' },
    ] as Field[],
    cols: [
      { title: 'Type', dataIndex: 'forType' },
      { title: 'Message', render: (_: unknown, t: Row) => `${t.starting}${t.content}${t.ending}` },
    ],
    logCols: [{ title: 'Number', dataIndex: 'number' }, { title: 'Type', dataIndex: 'type' }, { title: 'Message', dataIndex: 'body', ellipsis: true }],
    to: (r: Recipient) => r.contacts?.phone,
  },
  email: {
    tpl: '/email-templates', send: '/email/send', log: '/email/log', help: `${HELP}. Plain text only.`,
    fields: [
      { name: 'name', label: 'Name', required: true },
      { name: 'subject', label: 'Subject', required: true },
      { name: 'body', label: 'Body', area: true, required: true },
    ] as Field[],
    cols: [{ title: 'Name', dataIndex: 'name' }, { title: 'Subject', dataIndex: 'subject' }, { title: 'Body', dataIndex: 'body', ellipsis: true }],
    logCols: [{ title: 'Address', dataIndex: 'address' }, { title: 'Subject', dataIndex: 'subject', ellipsis: true }],
    to: (r: Recipient) => r.contacts?.email || r.contacts?.fatherEmail || r.contacts?.motherEmail,
  },
}
type Kind = keyof typeof KINDS

export default function Messaging() {
  return (
    <>
      <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message="Sending is STUB / log-only unless a real provider is configured on the server (SMS_PROVIDER, SMTP_*). Nothing leaves the machine; every attempt is only written to the log." />
      <Tabs items={[
        { key: 'sms', label: 'SMS', children: <Panel kind="sms" /> },
        { key: 'email', label: 'Email', children: <Panel kind="email" /> },
      ]} />
    </>
  )
}

function Panel({ kind }: { kind: Kind }) {
  const k = KINDS[kind]
  const { schoolId, yearId } = useSelection()
  const [tpls, setTpls] = useState<Row[]>([])
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const [form] = Form.useForm()

  const load = () => {
    if (!schoolId) return
    api<Row[]>(`${k.tpl}?schoolId=${schoolId}`).then(setTpls).catch((e) => message.error(e.message))
  }
  useEffect(load, [schoolId, kind])

  function open(t: Row | 'new') {
    form.resetFields()
    if (t !== 'new') form.setFieldsValue(t)
    setEditing(t)
  }
  async function save(v: Record<string, unknown>) {
    try {
      if (editing === 'new') await api(k.tpl, { method: 'POST', body: JSON.stringify({ ...v, schoolId }) })
      else await api(`${k.tpl}/${(editing as Row).id}`, { method: 'PATCH', body: JSON.stringify(v) })
      setEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  async function del(id: number) {
    try {
      await api(`${k.tpl}/${id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <Button type="primary" onClick={() => open('new')} style={{ marginBottom: 12 }}>Add template</Button>
      <Table rowKey="id" size="small" pagination={false} dataSource={tpls} scroll={{ x: true }} style={{ marginBottom: 24 }} columns={[
        ...k.cols,
        { title: '', render: (_: unknown, t: Row) => (
          <Space>
            <Button size="small" onClick={() => open(t)}>Edit</Button>
            <Popconfirm title="Delete this template?" onConfirm={() => del(t.id)}><Button size="small" danger>Delete</Button></Popconfirm>
          </Space>
        ) },
      ]} />
      <Modal title={editing === 'new' ? 'Add template' : 'Edit template'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save} initialValues={{ forType: 'general' }}>
          {k.fields.map((f) => (
            <Form.Item key={f.name} name={f.name} label={f.label} rules={[{ required: f.required }]}>
              {f.options ? <Select options={f.options.map((o) => ({ value: o, label: o }))} /> : f.area ? <Input.TextArea rows={4} /> : <Input />}
            </Form.Item>
          ))}
          <span style={{ color: 'gray' }}>{k.help}</span>
        </Form>
      </Modal>
      <SendPanel kind={kind} tpls={tpls} schoolId={schoolId} yearId={yearId} />
      <LogPanel kind={kind} schoolId={schoolId} />
    </>
  )
}

// ponytail: recipients come from /defaulters (the one list that carries enrollment ids today).
// General sends to every student need GET /students to return enrollment.id.
function SendPanel({ kind, tpls, schoolId, yearId }: { kind: Kind; tpls: Row[]; schoolId?: number; yearId?: number }) {
  const k = KINDS[kind]
  const [standards, setStandards] = useState<{ id: number; name: string }[]>([])
  const [standardId, setStandardId] = useState<number>()
  const [rows, setRows] = useState<Recipient[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [templateId, setTemplateId] = useState<number>()
  const [result, setResult] = useState<SendResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (schoolId) api<typeof standards>(`/standards?schoolId=${schoolId}`).then(setStandards).catch((e) => message.error(e.message))
  }, [schoolId])
  useEffect(() => setTemplateId((cur) => (tpls.some((t) => t.id === cur) ? cur : tpls[0]?.id)), [tpls])

  async function load() {
    if (!schoolId || !yearId) return
    const qs = new URLSearchParams({ schoolId: String(schoolId), yearId: String(yearId), contacts: 'true' })
    if (standardId) qs.set('standardId', String(standardId))
    try {
      setRows(await api<Recipient[]>(`/defaulters?${qs}`))
      setPicked([])
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  async function send() {
    setBusy(true)
    try {
      const enrollmentIds = rows.filter((r) => picked.includes(r.enrollmentId)).map((r) => r.enrollmentId)
      setResult(await api<SendResult>(k.send, { method: 'POST', body: JSON.stringify({ schoolId, yearId, templateId, enrollmentIds }) }))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const nameOf = (id: number) => rows.find((r) => r.enrollmentId === id)?.name ?? `#${id}`

  return (
    <>
      <h4>Send to students with overdue fees</h4>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="Class" style={{ width: 150 }} value={standardId} onChange={setStandardId} options={standards.map((s) => ({ value: s.id, label: s.name }))} />
        <Button onClick={load}>Load recipients</Button>
        <Select placeholder="Template" style={{ width: 240 }} value={templateId} onChange={setTemplateId}
          options={tpls.map((t) => ({ value: t.id, label: `#${t.id} ${(t.name ?? `${t.forType}: ${t.starting}${t.content}`).slice(0, 30)}` }))} />
        <Popconfirm title={`Send to ${picked.length} student(s)? (stub: log only unless a provider is configured)`} disabled={!picked.length || !templateId} onConfirm={send}>
          <Button type="primary" disabled={!picked.length || !templateId} loading={busy}>Send ({picked.length})</Button>
        </Popconfirm>
      </Space>
      <Table rowKey="enrollmentId" size="small" dataSource={rows} pagination={{ pageSize: 10 }} scroll={{ x: true }}
        rowSelection={{ selectedRowKeys: picked, onChange: (s) => setPicked(s as number[]) }}
        columns={[
          { title: 'Adm. no', dataIndex: 'admissionNo' },
          { title: 'Name', dataIndex: 'name' },
          { title: 'Class', dataIndex: 'className' },
          { title: kind === 'sms' ? 'Mobile' : 'Email', render: (_, r) => k.to(r) || <Tag>none</Tag> },
        ]} />
      <Modal title="Send result" open={!!result} onCancel={() => setResult(null)} footer={null}>
        {result && (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`${result.sent} of ${result.results.length} sent (stub providers only log).`} />
            <Table rowKey="enrollmentId" size="small" pagination={{ pageSize: 8 }} dataSource={result.results.filter((r) => r.status !== 'SENT')}
              columns={[{ title: 'Student', dataIndex: 'enrollmentId', render: nameOf }, { title: 'Status', dataIndex: 'status' }, { title: 'Reason', dataIndex: 'reason' }]} />
          </>
        )}
      </Modal>
    </>
  )
}

function LogPanel({ kind, schoolId }: { kind: Kind; schoolId?: number }) {
  const k = KINDS[kind]
  const [status, setStatus] = useState<string>()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState<Row[]>([])

  const load = () => {
    if (!schoolId) return
    const qs = new URLSearchParams({ schoolId: String(schoolId) })
    if (status) qs.set('status', status)
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    api<Row[]>(`${k.log}?${qs}`).then(setRows).catch((e) => message.error(e.message))
  }
  useEffect(load, [schoolId, kind])

  return (
    <>
      <h4 style={{ marginTop: 24 }}>Log (last 500)</h4>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="Status" style={{ width: 120 }} value={status} onChange={setStatus}
          options={['QUEUED', 'SENT', 'FAILED'].map((s) => ({ value: s, label: s }))} />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
        <Button onClick={load}>Filter</Button>
      </Space>
      <Table rowKey="id" size="small" dataSource={rows} pagination={{ pageSize: 10 }} scroll={{ x: true }} columns={[
        { title: 'When', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
        ...k.logCols,
        { title: 'Status', dataIndex: 'status', render: (v: string) => <Tag color={v === 'SENT' ? 'green' : v === 'FAILED' ? 'red' : undefined}>{v}</Tag> },
        { title: 'Provider response', dataIndex: 'providerResponse', ellipsis: true },
      ]} />
    </>
  )
}
