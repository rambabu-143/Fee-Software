import { Button, Form, Input, InputNumber, Modal, Select, Space, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from './api'

type Installment = { id: number; number: number; label: string }
type Row = { installmentId: number; amount: string; remarks: string }

// Per-student fine overrides for the selected year: a fixed fine for an installment instead of the
// calculated one (0 waives it). The server replaces the whole list on save.
export function FinesModal({ student, schoolId, yearId, onClose }: {
  student: { id: number; name: string } | null; schoolId?: number; yearId?: number; onClose: () => void
}) {
  const [form] = Form.useForm()
  const [installments, setInstallments] = useState<Installment[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!student) return
    form.resetFields()
    Promise.all([
      api<Installment[]>(`/installments?schoolId=${schoolId}&yearId=${yearId}`),
      api<Row[]>(`/students/${student.id}/fines?yearId=${yearId}`),
    ])
      .then(([i, rows]) => {
        setInstallments(i)
        form.setFieldValue('items', rows.map((r) => ({ ...r, amount: Number(r.amount) })))
      })
      .catch((e) => message.error(e.message))
  }, [student, schoolId, yearId])

  async function save({ items = [] }: { items?: { installmentId: number; amount: number; remarks: string }[] }) {
    setSaving(true)
    try {
      await api(`/students/${student!.id}/fines`, { method: 'PUT', body: JSON.stringify({ yearId, items }) })
      message.success('Fines saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={student && `Fine override · ${student.name}`} open={!!student} onCancel={onClose} onOk={form.submit}
      okText="Save" confirmLoading={saving} width={680}>
      <Form form={form} onFinish={save}>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((f) => (
                <Space key={f.key} wrap align="start">
                  <Form.Item name={[f.name, 'installmentId']} rules={[{ required: true, message: 'Installment' }]}>
                    <Select placeholder="Installment" style={{ width: 150 }} options={installments.map((i) => ({ value: i.id, label: i.label }))} />
                  </Form.Item>
                  <Form.Item name={[f.name, 'amount']} rules={[{ required: true, message: 'Fine (0 = waive)' }]}>
                    <InputNumber min={0} precision={2} prefix="₹" placeholder="Fine (0 = waive)" style={{ width: 150 }} />
                  </Form.Item>
                  <Form.Item name={[f.name, 'remarks']} rules={[{ required: true, min: 2, message: 'Remarks' }]}>
                    <Input placeholder="Remarks (e.g. Waived by principal)" style={{ width: 220 }} />
                  </Form.Item>
                  <Button danger onClick={() => remove(f.name)}>Remove</Button>
                </Space>
              ))}
              <Button type="dashed" onClick={() => add()} block>Add fine override</Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  )
}
