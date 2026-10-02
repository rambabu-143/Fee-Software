import { Button, Card, Form, Input, InputNumber, Select, Space, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'
import { BillView, type Bill } from '../bill'
import { ReceiptModal, modes, type Receipt } from '../receipt'

type StudentRow = { id: number; admissionNo: string; name: string; enrollment: { className: string } }
const today = () => new Date().toISOString().slice(0, 10)

export default function CollectFee() {
  const { schoolId, yearId } = useSelection()
  const [students, setStudents] = useState<StudentRow[]>([])
  const [studentId, setStudentId] = useState<number>()
  const [bill, setBill] = useState<Bill | null>(null)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const mode = Form.useWatch('mode', form)
  const date = Form.useWatch('date', form)

  // ponytail: loads the year's roster (API caps at 500) and filters client-side; switch to server search past that.
  useEffect(() => {
    if (!schoolId || !yearId) return
    setStudentId(undefined)
    api<StudentRow[]>(`/students?schoolId=${schoolId}&yearId=${yearId}`).then(setStudents).catch((e) => message.error(e.message))
  }, [schoolId, yearId])

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
      const r = await api<Receipt>('/payments', { method: 'POST', body: JSON.stringify({ ...values, studentId, yearId }) })
      setReceipt(r)
      form.setFieldsValue({ reference: undefined, remarks: undefined })
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
            {mode !== 'CASH' && (
              <Form.Item name="reference" label="Reference" rules={[{ required: true, min: 3 }]}>
                <Input placeholder="Cheque / txn no." />
              </Form.Item>
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
