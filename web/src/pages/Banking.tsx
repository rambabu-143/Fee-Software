import { Button, Card, Form, Input, Modal, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api, openPdf } from '../api'
import { Gate, useCan } from '../session'
import { useSelection } from '../selection'
import { inr } from '../bill'
import { modes, type Receipt } from '../receipt'
import { ReconcileModal, downloadFile, qs } from '../moneyShared'

type Bank = { id: number; name: string; accountNo: string | null; ifsc: string | null; active: boolean }
type BankRow = {
  receiptNo: number; studentName: string; admissionNo: string; mode: string; bank: string | null; chequeNo: string | null
  receiptDate: string; bankDate: string | null; amount: string; fine: string; status: string; flag: string | null
}
type FineRow = { receiptNo: number; date: string; admissionNo: string; studentName: string; mode: string; fine: string }

const statusTone: Record<string, string> = { PENDING: 'gold', CLEARED: 'green', BOUNCED: 'red' }

function BanksTab() {
  const { schoolId } = useSelection()
  const [rows, setRows] = useState<Bank[]>([])
  const [editing, setEditing] = useState<Bank | 'new' | null>(null)
  const [form] = Form.useForm()
  const load = () => (schoolId ? api<Bank[]>(`/banks?schoolId=${schoolId}`).then(setRows).catch((e) => message.error(e.message)) : undefined)
  useEffect(() => {
    load()
  }, [schoolId])

  function open(b: Bank | 'new') {
    setEditing(b)
    form.resetFields()
    if (b !== 'new') form.setFieldsValue(b)
    else form.setFieldsValue({ active: true })
  }
  async function save(v: Record<string, unknown>) {
    try {
      if (editing === 'new') await api('/banks', { method: 'POST', body: JSON.stringify({ name: v.name, accountNo: v.accountNo || undefined, ifsc: v.ifsc || undefined, schoolId }) })
      else await api(`/banks/${editing!.id}`, { method: 'PATCH', body: JSON.stringify({ name: v.name, accountNo: v.accountNo ?? '', ifsc: v.ifsc ?? '', active: v.active }) })
      setEditing(null)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  return (
    <>
      <Gate cap="banks.write"><Button type="primary" onClick={() => open('new')} style={{ marginBottom: 16 }}>Add bank</Button></Gate>
      <Table rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} columns={[
        { title: 'Bank', dataIndex: 'name' }, { title: 'Account no.', dataIndex: 'accountNo' }, { title: 'IFSC', dataIndex: 'ifsc' },
        { title: 'Status', dataIndex: 'active', render: (a: boolean) => (a ? <Tag color="green">Active</Tag> : <Tag>Inactive</Tag>) },
        { title: '', render: (_, b) => <Gate cap="banks.write" hide><Button size="small" onClick={() => open(b)}>Edit</Button></Gate> },
      ]} />
      <Modal title={editing === 'new' ? 'Add bank' : 'Edit bank'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Bank name" rules={[{ required: true, min: 2 }]}><Input /></Form.Item>
          <Form.Item name="accountNo" label="Account no."><Input /></Form.Item>
          <Form.Item name="ifsc" label="IFSC"><Input /></Form.Item>
          {editing !== 'new' && <Form.Item name="active" label="Active (inactive banks can't take new cheques)" valuePropName="checked"><Switch /></Form.Item>}
        </Form>
      </Modal>
    </>
  )
}

// Cheque / online receipts the bank hasn't confirmed yet.
function ReconcileTab() {
  const { schoolId, yearId } = useSelection()
  const [rows, setRows] = useState<Receipt[]>([])
  const [rec, setRec] = useState<Receipt | null>(null)
  const [banks, setBanks] = useState<Record<number, string>>({})
  const load = () =>
    schoolId && yearId
      ? api<Receipt[]>(`/payments?schoolId=${schoolId}&yearId=${yearId}`)
        .then((r) => setRows(r.filter((x) => x.mode !== 'CASH' && !x.cancelledAt && x.clearStatus === 'PENDING').sort((a, b) => a.receiptNo - b.receiptNo)))
        .catch((e) => message.error(e.message))
      : undefined
  useEffect(() => {
    load()
    if (schoolId) api<Bank[]>(`/banks?schoolId=${schoolId}`).then((b) => setBanks(Object.fromEntries(b.map((x) => [x.id, x.name])))).catch(() => setBanks({}))
  }, [schoolId, yearId])

  const future = (r: Receipt) => !!r.chequeDate && r.chequeDate.slice(0, 10) > new Date().toISOString().slice(0, 10)
  return (
    <>
      <p>{rows.length} receipts waiting for the bank · <b>{inr(String(rows.reduce((s, r) => s + Number(r.amount), 0)))}</b></p>
      <Table rowKey="id" dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 25 }} columns={[
        { title: 'No.', dataIndex: 'receiptNo' },
        { title: 'Date', dataIndex: 'date', render: (v: string) => v.slice(0, 10) },
        { title: 'Student', render: (_, r) => `${r.student.name} (${r.student.admissionNo})` },
        { title: 'Mode', dataIndex: 'mode' },
        { title: 'Bank', render: (_, r) => (r.bankId ? (banks[r.bankId] ?? `#${r.bankId}`) : '') },
        { title: 'Cheque', render: (_, r) => (r.chequeNo ? <>{r.chequeNo}{r.chequeDate ? ` · ${r.chequeDate.slice(0, 10)}` : ''} {future(r) && <Tag color="orange">Post-dated</Tag>}</> : r.reference) },
        { title: 'Amount', dataIndex: 'amount', align: 'right', render: inr },
        { title: '', render: (_, r) => <Button size="small" type="primary" onClick={() => setRec(r)}>Reconcile</Button> },
      ]} />
      <ReconcileModal receipt={rec} onClose={() => setRec(null)} onDone={() => load()} />
    </>
  )
}

function ReportTab() {
  const { schoolId, yearId } = useSelection()
  const [banks, setBanks] = useState<Bank[]>([])
  const [f, setF] = useState<{ from?: string; to?: string; mode?: string; bankId?: number; status?: string }>({})
  const [data, setData] = useState<{ rows: BankRow[]; totals: { count: number; amount: string; fine: string } } | null>(null)
  useEffect(() => {
    if (schoolId) api<Bank[]>(`/banks?schoolId=${schoolId}`).then(setBanks).catch(() => setBanks([]))
  }, [schoolId])
  const q = () => qs({ schoolId, yearId, ...f })
  useEffect(() => {
    if (schoolId && yearId) api<NonNullable<typeof data>>(`/reports/banking?${q()}`).then(setData).catch((e) => message.error(e.message))
  }, [schoolId, yearId, f])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space wrap>
        By bank date: <Input type="date" onChange={(e) => setF({ ...f, from: e.target.value })} /> to <Input type="date" onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select allowClear placeholder="Mode" style={{ width: 150 }} options={modes} onChange={(mode) => setF({ ...f, mode })} />
        <Select allowClear placeholder="Bank" style={{ width: 170 }} options={banks.map((b) => ({ value: b.id, label: b.name }))} onChange={(bankId) => setF({ ...f, bankId })} />
        <Select allowClear placeholder="Status" style={{ width: 130 }} options={['PENDING', 'CLEARED', 'BOUNCED'].map((s) => ({ value: s, label: s }))} onChange={(status) => setF({ ...f, status })} />
        <Button onClick={() => openPdf(`/reports/banking?${q()}&pdf=1`).catch((e) => message.error(e.message))}>PDF</Button>
        <Button onClick={() => downloadFile(`/reports/banking?${q()}&format=csv`, 'banking.csv').catch((e) => message.error(e.message))}>CSV</Button>
      </Space>
      {data && <span>{data.totals.count} receipts · amount <b>{inr(data.totals.amount)}</b> · fine <b>{inr(data.totals.fine)}</b> (bounced receipts are listed but not counted)</span>}
      <Table rowKey="receiptNo" dataSource={data?.rows ?? []} scroll={{ x: true }} pagination={{ pageSize: 25 }}
        onRow={(r) => ({ style: r.status === 'BOUNCED' ? { opacity: 0.55 } : {} })} columns={[
          { title: 'No.', dataIndex: 'receiptNo' },
          { title: 'Student', render: (_, r) => `${r.studentName} (${r.admissionNo})` },
          { title: 'Mode', dataIndex: 'mode' }, { title: 'Bank', dataIndex: 'bank' }, { title: 'Cheque', dataIndex: 'chequeNo' },
          { title: 'Received', dataIndex: 'receiptDate' }, { title: 'Bank date', dataIndex: 'bankDate', render: (v: string | null) => v ?? '-' },
          { title: 'Amount', dataIndex: 'amount', align: 'right', render: inr }, { title: 'Fine', dataIndex: 'fine', align: 'right', render: inr },
          { title: 'Status', render: (_, r) => <>{<Tag color={statusTone[r.status]}>{r.status}</Tag>}{r.flag === 'FUTURE_CHEQUE' && <Tag color="orange">Post-dated</Tag>}</> },
        ]} />
    </Space>
  )
}

function FinesTab() {
  const { schoolId, yearId } = useSelection()
  const [f, setF] = useState<{ from?: string; to?: string }>({})
  const [data, setData] = useState<{ rows: FineRow[]; totals: { count: number; fine: string } } | null>(null)
  const q = () => qs({ schoolId, yearId, ...f })
  useEffect(() => {
    if (schoolId && yearId) api<NonNullable<typeof data>>(`/reports/fines?${q()}`).then(setData).catch((e) => message.error(e.message))
  }, [schoolId, yearId, f])
  return (
    <Card size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          From <Input type="date" onChange={(e) => setF({ ...f, from: e.target.value })} /> to <Input type="date" onChange={(e) => setF({ ...f, to: e.target.value })} />
          <Button onClick={() => downloadFile(`/reports/fines?${q()}&format=csv`, 'fines.csv').catch((e) => message.error(e.message))}>CSV</Button>
          {data && <span>{data.totals.count} receipts with fine · <b>{inr(data.totals.fine)}</b></span>}
        </Space>
        <Table rowKey="receiptNo" size="small" dataSource={data?.rows ?? []} pagination={{ pageSize: 25 }} columns={[
          { title: 'No.', dataIndex: 'receiptNo' }, { title: 'Date', dataIndex: 'date' },
          { title: 'Student', render: (_, r) => `${r.studentName} (${r.admissionNo})` }, { title: 'Mode', dataIndex: 'mode' },
          { title: 'Fine', dataIndex: 'fine', align: 'right', render: inr },
        ]} />
      </Space>
    </Card>
  )
}

export default function Banking() {
  // GET /banks and the pending-receipt list are ADMIN/ACCOUNTANT only; the two reports are open to all.
  const staff = useCan()('banks.read')
  return (
    <Tabs items={[
      ...(staff ? [{ key: 'r', label: 'Reconcile', children: <ReconcileTab /> }] : []),
      { key: 'rep', label: 'Banking report', children: <ReportTab /> },
      { key: 'f', label: 'Fines', children: <FinesTab /> },
      ...(staff ? [{ key: 'b', label: 'Banks', children: <BanksTab /> }] : []),
    ]} />
  )
}
