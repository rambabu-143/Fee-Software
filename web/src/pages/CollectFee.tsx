import { Button, Card, Form, Input, InputNumber, Select, Space, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'
import { BillView, type Bill } from '../bill'
import { ReceiptModal, modes, type Receipt } from '../receipt'

type Bank = { id: number; name: string; active: boolean }

type StudentRow = { id: number; admissionNo: string; name: string; enrollment: { className: string } }
const today = () => new Date().toISOString().slice(0, 10)

export default function CollectFee() {
  const { schoolId, yearId } = useSelection()
  const [students, setStudents] = useState<StudentRow[]>([])
  const [studentId, setStudentId] = useState<number>()
  const [bill, setBill] = useState<Bill | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [saving, setSaving] = useState(false)
  const [banks, setBanks] = useState<Bank[]>([])
  const [form] = Form.useForm()
  const mode = Form.useWatch('mode', form)
  const date = Form.useWatch('date', form)

  // ponytail: loads the year's roster (API caps at 500) and filters client-side; switch to server search past that.
  useEffect(() => {
    if (!schoolId || !yearId) return
    setStudentId(undefined)
    api<StudentRow[]>(`/students?schoolId=${schoolId}&yearId=${yearId}`).then(setStudents).catch((e) => message.error(e.message))
  }, [schoolId, yearId])

  // Bank master is ADMIN/ACCOUNTANT only; a 403 just leaves the bank list empty.
  useEffect(() => {
    if (schoolId) api<Bank[]>(`/banks?schoolId=${schoolId}`).then((b) => setBanks(b.filter((x) => x.active))).catch(() => setBanks([]))
  }, [schoolId])

  const loadBill = async () => {
    if (!studentId || !date) return setBill(null)
    const b = await api<Bill>(`/students/${studentId}/bill?yearId=${yearId}&asOf=${date}`)
    setBill(b)
    form.setFieldValue('amount', Number(b.totals.due) || undefined)
  }
  useEffect(() => {
    loadBill().catch((e) => message.error(e.message))
  }, [studentId, date])

  async function collect(values: Record<string, unknown>) {
    setSaving(true)
    try {
      // Send only the fields that belong to the chosen mode (the API rejects a bank/cheque on cash).
      // A cheque's reference is its number; other non-cash modes keep the typed reference.
      const { bankId, chequeNo, chequeDate, reference, ...rest } = values as Record<string, string | number | undefined>
      const extra = rest.mode === 'CHEQUE' ? { bankId, chequeNo, chequeDate: chequeDate || undefined, reference: chequeNo }
        : rest.mode === 'CASH' ? {} : { reference, bankId }
      const r = await api<Receipt>('/payments', { method: 'POST', body: JSON.stringify({ ...rest, ...extra, studentId, yearId }) })
      setReceipt(r)
      form.setFieldsValue({ reference: undefined, chequeNo: undefined, chequeDate: undefined, remarks: undefined })
      await loadBill()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Select showSearch style={{ width: '100%', maxWidth: 480 }} placeholder="Search student by name or admission no."
        value={studentId} onChange={setStudentId} optionFilterProp="label"
        options={students.map((s) => ({ value: s.id, label: `${s.admissionNo} · ${s.name} · ${s.enrollment.className}` }))} />

      {studentId && (
        <Card size="small" title="Payment">
          <Form form={form} layout="inline" onFinish={collect} initialValues={{ mode: 'CASH', date: today() }} style={{ rowGap: 8 }}>
            <Form.Item name="date" label="Date" rules={[{ required: true }]}>
              <Input type="date" max={today()} />
            </Form.Item>
            <Form.Item name="amount" label="Amount" rules={[{ required: true }]}>
              <InputNumber min={0.01} precision={2} prefix="₹" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="mode" label="Mode">
              <Select options={modes} style={{ width: 150 }} />
            </Form.Item>
            {mode === 'CHEQUE' && (
              <>
                <Form.Item name="bankId" label="Bank" rules={[{ required: true, message: 'Select the cheque\'s bank' }]} preserve={false}>
                  <Select style={{ width: 200 }} placeholder="Bank" options={banks.map((b) => ({ value: b.id, label: b.name }))} />
                </Form.Item>
                <Form.Item name="chequeNo" label="Cheque no." rules={[{ required: true, min: 3, message: 'At least 3 characters' }]} preserve={false}>
                  <Input />
                </Form.Item>
                <Form.Item name="chequeDate" label="Cheque date" preserve={false}>
                  <Input type="date" />
                </Form.Item>
              </>
            )}
            {mode && mode !== 'CASH' && mode !== 'CHEQUE' && (
              <>
                <Form.Item name="reference" label="Reference" rules={[{ required: true, min: 3, message: 'At least 3 characters' }]} preserve={false}>
                  <Input placeholder="Txn / UTR no." />
                </Form.Item>
                <Form.Item name="bankId" label="Received in" preserve={false}>
                  <Select allowClear style={{ width: 200 }} placeholder="Bank (optional)" options={banks.map((b) => ({ value: b.id, label: b.name }))} />
                </Form.Item>
              </>
            )}
            <Form.Item name="remarks" label="Remarks">
              <Input />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={saving} disabled={!bill || Number(bill.totals.due) === 0}>Collect</Button>
          </Form>
        </Card>
      )}

      {bill && <Card size="small" title={`Bill as of ${date}`}><BillView bill={bill} /></Card>}
      <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />
    </Space>
  )
}
