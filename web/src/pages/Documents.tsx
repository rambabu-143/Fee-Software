import { Alert, Button, Checkbox, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api, openBlob, saveBlob } from '../api'
import { useSelection } from '../selection'
import { inr } from '../bill'

type Stu = { id: number; admissionNo: string; name: string; enrollment: { sectionId: number; standardId: number; className: string } }
type Doc = { id: number; type: string; serialNo: number; yearId: number; issuedOn: string; issuedBy: string; supersededAt: string | null }
type Standard = { id: number; name: string; sections: { id: number; name: string }[] }
type Cert = {
  year: string
  lines: { date: string; receiptNo: number; mode: string; installments: string; charges: string; fine: string; amount: string }[]
  total: string
}

const fail = (e: unknown) => message.error((e as Error).message)

// Remote-search student picker; the student must be enrolled in `yearId`.
function StudentPicker({ yearId, value, onChange }: { yearId?: number; value?: number; onChange: (id?: number) => void }) {
  const { schoolId } = useSelection()
  const [opts, setOpts] = useState<Stu[]>([])
  const search = (q: string) => {
    if (!schoolId || !yearId) return
    api<Stu[]>(`/students?schoolId=${schoolId}&yearId=${yearId}&q=${encodeURIComponent(q)}`)
      .then((r) => setOpts(r.slice(0, 50)))
      .catch(fail)
  }
  useEffect(() => {
    onChange(undefined)
    setOpts([])
    search('')
  }, [schoolId, yearId])
  return (
    <Select showSearch allowClear filterOption={false} value={value} onSearch={search} onChange={onChange}
      placeholder="Search admission no. or name" style={{ width: 360 }}
      options={opts.map((s) => ({ value: s.id, label: `${s.admissionNo} · ${s.name} (${s.enrollment.className})` }))} />
  )
}

function TransferCertificate() {
  const { yearId } = useSelection()
  const [sid, setSid] = useState<number>()
  const [docs, setDocs] = useState<Doc[]>([])
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()

  const loadDocs = (id = sid) => (id ? api<Doc[]>(`/students/${id}/documents`).then(setDocs).catch(fail) : setDocs([]))
  useEffect(() => void loadDocs(), [sid])

  async function issue(v: Record<string, unknown>) {
    setBusy(true)
    try {
      const typed = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null)) // cleared inputs are ''; API rejects '' dates
      const body = { ...typed, studentId: sid, yearId, overrideDues: !!v.overrideDues }
      const h = await openBlob('/documents/tc', { method: 'POST', body: JSON.stringify(body) })
      message.success(`TC issued, serial ${h.get('X-Serial-No')}`)
      loadDocs()
    } catch (e) {
      fail(e)
    }
    setBusy(false)
  }

  const tcs = docs.filter((d) => d.type === 'TC')
  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <StudentPicker yearId={yearId} value={sid} onChange={setSid} />
      </Space>
      {sid && (
        <>
          <Form form={form} layout="vertical" onFinish={issue} style={{ maxWidth: 720 }}>
            <Space wrap align="start">
              <Form.Item name="dateOfIssue" label="Date of issue" rules={[{ required: true }]}><Input type="date" /></Form.Item>
              <Form.Item name="dateOfWithdrawal" label="Date of leaving (blank = from withdrawal record)"><Input type="date" /></Form.Item>
              <Form.Item name="leavingReason" label="Reason for leaving" rules={[{ required: true, min: 2 }]}><Input style={{ width: 280 }} /></Form.Item>
            </Space>
            <Space wrap align="start">
              <Form.Item name="class" label="Class (blank = current)"><Input /></Form.Item>
              <Form.Item name="board" label="Board"><Input /></Form.Item>
              <Form.Item name="higherClass" label="Eligible for higher class"><Input /></Form.Item>
              <Form.Item name="combo" label="Subject combination"><Input /></Form.Item>
            </Space>
            <Space wrap align="start">
              <Form.Item name="monthDuePaid" label="Dues paid up to"><Input /></Form.Item>
              <Form.Item name="totalWorkDays" label="Working days"><InputNumber min={0} precision={0} /></Form.Item>
              <Form.Item name="totalWorkPresent" label="Days present"><InputNumber min={0} precision={0} /></Form.Item>
              <Form.Item name="generalConduct" label="General conduct"><Input /></Form.Item>
              <Form.Item name="nationality" label="Nationality"><Input /></Form.Item>
              <Form.Item name="staffName" label="Issued by (staff)"><Input /></Form.Item>
            </Space>
            <Form.Item name="overrideDues" valuePropName="checked">
              <Checkbox>Issue even if fees are pending (override)</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={busy}>Issue TC &amp; open PDF</Button>
            <span style={{ marginLeft: 12, color: '#888' }}>A second TC for the same student is marked Duplicate and supersedes the first.</span>
          </Form>
          <Table rowKey="id" style={{ marginTop: 24 }} dataSource={docs} pagination={false} size="small" columns={[
            { title: 'Type', dataIndex: 'type' },
            { title: 'Serial', dataIndex: 'serialNo' },
            { title: 'Issued', dataIndex: 'issuedOn', render: (v: string) => v.slice(0, 10) },
            { title: 'By', dataIndex: 'issuedBy' },
            {
              title: 'Status', render: (_, d) => (
                <Space>
                  {d.supersededAt ? <Tag color="orange">Superseded</Tag> : <Tag color="green">Current</Tag>}
                  {/* every TC after the first for this student is a duplicate (each issue supersedes the prior) */}
                  {d.type === 'TC' && tcs.indexOf(d) < tcs.length - 1 && <Tag>Duplicate</Tag>}
                </Space>
              ),
            },
            {
              title: '', render: (_, d) => d.type === 'TC' && (
                <Button size="small" onClick={() => openBlob(`/documents/tc/${d.id}/pdf`).catch(fail)}>Reprint</Button>
              ),
            },
          ]} />
        </>
      )}
    </>
  )
}

function FeeCertificate() {
  const { years, yearId: selYear } = useSelection()
  const [yid, setYid] = useState(selYear)
  const [sid, setSid] = useState<number>()
  const [cert, setCert] = useState<Cert | null>(null)
  useEffect(() => setYid(selYear), [selYear])
  useEffect(() => setCert(null), [sid, yid])

  const path = `/students/${sid}/fee-certificate?yearId=${yid}`
  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select value={yid} onChange={setYid} style={{ width: 120 }} options={years.map((y) => ({ value: y.id, label: y.label }))} />
        <StudentPicker yearId={yid} value={sid} onChange={setSid} />
        <Button disabled={!sid} onClick={() => api<Cert>(`${path}&json=1`).then(setCert).catch(fail)}>Preview</Button>
        <Button type="primary" disabled={!sid} onClick={() => openBlob(path).catch(fail)}>Open PDF</Button>
      </Space>
      {cert && (
        <Table rowKey="receiptNo" dataSource={cert.lines} pagination={false} size="small" scroll={{ x: true }}
          locale={{ emptyText: 'No receipts in this year' }}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={6}><b>Total paid, {cert.year}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right"><b>{inr(cert.total)}</b></Table.Summary.Cell>
            </Table.Summary.Row>
          )}
          columns={[
            { title: 'Date', dataIndex: 'date' },
            { title: 'Receipt', dataIndex: 'receiptNo' },
            { title: 'Mode', dataIndex: 'mode' },
            { title: 'Installments', dataIndex: 'installments' },
            { title: 'Charges', dataIndex: 'charges', align: 'right', render: inr },
            { title: 'Fine', dataIndex: 'fine', align: 'right', render: inr },
            { title: 'Amount', dataIndex: 'amount', align: 'right', render: inr },
          ]} />
      )}
    </>
  )
}

function AdmissionCertificate() {
  const { yearId } = useSelection()
  const [sid, setSid] = useState<number>()
  const [to, setTo] = useState<'both' | 'father' | 'mother'>('both')
  const [res, setRes] = useState<{ logged: string[]; skipped: number } | null>(null)
  useEffect(() => setRes(null), [sid])

  async function send() {
    try {
      setRes(await api(`/students/${sid}/admission-certificate/send`, { method: 'POST', body: JSON.stringify({ yearId, to }) }))
    } catch (e) {
      fail(e)
    }
  }
  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <StudentPicker yearId={yearId} value={sid} onChange={setSid} />
        <Button type="primary" disabled={!sid} onClick={() => openBlob(`/students/${sid}/admission-certificate.pdf?yearId=${yearId}`).catch(fail)}>Open PDF</Button>
        <Select value={to} onChange={setTo} style={{ width: 120 }}
          options={['both', 'father', 'mother'].map((v) => ({ value: v, label: v }))} />
        <Button disabled={!sid} onClick={send}>Email parents</Button>
      </Space>
      <Alert type="info" showIcon style={{ maxWidth: 640 }}
        message="Email is a stub: the request is logged as QUEUED and nothing is actually sent until SMTP is configured." />
      {res && (
        <Alert style={{ maxWidth: 640, marginTop: 12 }} type={res.logged.length ? 'success' : 'warning'} showIcon
          message={res.logged.length ? `Queued (not sent) for: ${res.logged.join(', ')}` : 'No valid parent email on file; nothing queued'}
          description={res.skipped ? `${res.skipped} address(es) skipped (blank or invalid).` : undefined} />
      )}
    </>
  )
}

function ClassForms() {
  const { schoolId, yearId } = useSelection()
  const [standards, setStandards] = useState<Standard[]>([])
  const [stdId, setStdId] = useState<number>()
  const [secId, setSecId] = useState<number>()
  const [students, setStudents] = useState<Stu[]>([])
  const [ids, setIds] = useState<number[]>([])
  const [lastDate, setLastDate] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setStdId(undefined)
    if (schoolId) api<Standard[]>(`/standards?schoolId=${schoolId}`).then(setStandards).catch(fail)
  }, [schoolId])
  useEffect(() => {
    setSecId(undefined)
  }, [stdId])
  useEffect(() => {
    setIds([])
    setStudents([])
    if (schoolId && yearId && stdId && secId)
      api<Stu[]>(`/students?schoolId=${schoolId}&yearId=${yearId}&standardId=${stdId}`)
        .then((r) => setStudents(r.filter((s) => s.enrollment.sectionId === secId)))
        .catch(fail)
  }, [schoolId, yearId, stdId, secId])

  const subset = ids.length ? `&studentIds=${ids.join(',')}` : ''
  async function download(kind: 'admission' | 'concession') {
    setBusy(true)
    try {
      const p = kind === 'admission'
        ? `/sections/${secId}/admission-forms.zip?yearId=${yearId}${subset}`
        : `/sections/${secId}/concession-forms.zip?yearId=${yearId}&lastDate=${lastDate}${subset}`
      await saveBlob(p, `${kind}-forms.zip`)
    } catch (e) {
      const m = (e as Error).message
      message.error(/At most \d+ forms/.test(m) ? `${m}. Select specific students below.` : m, 8)
    }
    setBusy(false)
  }

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select placeholder="Class" value={stdId} onChange={setStdId} style={{ width: 160 }}
          options={standards.map((s) => ({ value: s.id, label: s.name }))} />
        <Select placeholder="Section" value={secId} onChange={setSecId} style={{ width: 120 }}
          options={standards.find((s) => s.id === stdId)?.sections.map((s) => ({ value: s.id, label: s.name }))} />
      </Space>
      <div style={{ marginBottom: 16 }}>
        <Select mode="multiple" allowClear value={ids} onChange={setIds} disabled={!secId} style={{ minWidth: 360, maxWidth: '100%' }}
          placeholder={`Optional: only these students (blank = all ${students.length || ''})`}
          optionFilterProp="label" options={students.map((s) => ({ value: s.id, label: `${s.admissionNo} · ${s.name}` }))} />
      </div>
      <Space wrap>
        <Button type="primary" disabled={!secId} loading={busy} onClick={() => download('admission')}>Prep-to-I admission forms (ZIP)</Button>
        Last submission date <Input type="date" value={lastDate} onChange={(e) => setLastDate(e.target.value)} style={{ width: 160 }} />
        <Button type="primary" disabled={!secId || !lastDate} loading={busy} onClick={() => download('concession')}>Concession forms (ZIP)</Button>
      </Space>
      <p style={{ color: '#888', marginTop: 12 }}>
        At most 60 forms per ZIP. Concession forms skip students with no concession or a staff concession (listed in _skipped.txt inside the ZIP).
      </p>
    </>
  )
}

export default function Documents() {
  return (
    <Tabs destroyOnHidden items={[
      { key: 'tc', label: 'Transfer Certificate', children: <TransferCertificate /> },
      { key: 'fee', label: 'Fee Certificate (ITC)', children: <FeeCertificate /> },
      { key: 'adm', label: 'Admission Certificate', children: <AdmissionCertificate /> },
      { key: 'forms', label: 'Class Forms', children: <ClassForms /> },
    ]} />
  )
}
