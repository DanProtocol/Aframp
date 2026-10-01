/**
 * The component builds its return URL from `window.location.origin`, and
 * redirects off-site via `lib/navigation`. `window.location` is a
 * non-configurable accessor in jsdom, so neither the origin nor the redirect
 * can be asserted by touching the real object — the URL is set here instead,
 * and the redirect is asserted through the mocked module.
 *
 * @jest-environment-options {"url": "https://app.aframp.com/charge"}
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api, ApiError } from '@/lib/api'
import { OZOW_BANKS } from '@/lib/payment-providers'
import { redirectTo } from '@/lib/navigation'
import { ZarOnramp } from '../zar-onramp'

jest.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message)
      this.name = 'ApiError'
    }
  }
  return {
    api: {
      createOzowPayment: jest.fn(),
    },
    ApiError,
  }
})

jest.mock('@/lib/navigation', () => ({ redirectTo: jest.fn() }))

// Replace the Radix Select with a plain <select> so a bank can be chosen with
// an ordinary DOM event. Radix renders a portal-based listbox that userEvent
// can't drive reliably in jsdom, and the point of these tests is the Ozow
// call and redirect, not the widget.
jest.mock('@/components/ui/select', () => {
  const React = jest.requireActual('react')
  return {
    Select: ({ value, onValueChange, children }: any) =>
      React.createElement(
        'select',
        {
          'aria-label': 'bank',
          value,
          onChange: (event: any) => onValueChange(event.target.value),
        },
        children
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => children,
    SelectItem: ({ value, children }: any) => React.createElement('option', { value }, children),
  }
})

const mockCreateOzowPayment = api.createOzowPayment as jest.Mock
const mockRedirectTo = redirectTo as jest.Mock

const PAYMENT_URL = 'https://payments.ozow.com/pay/abc123'
const ORIGIN = 'https://app.aframp.com'

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateOzowPayment.mockResolvedValue({ payment_url: PAYMENT_URL, transaction_id: 'txn-1' })
})

function renderOnramp() {
  return render(<ZarOnramp token="test-token" />)
}

const amountField = () => screen.getByLabelText('Amount (ZAR)')
const submitButton = () => screen.getByRole('button', { name: /continue to ozow/i })
const bankSelect = () => screen.getByLabelText('bank')

/** Fills the form with a valid amount and a bank, leaving it ready to submit. */
async function fillValidForm(user: ReturnType<typeof userEvent.setup>, bank = 'FNB') {
  await user.type(amountField(), '100')
  fireEvent.change(bankSelect(), { target: { value: bank } })
}

describe('ZarOnramp form validation', () => {
  it('renders the form with the submit button disabled', () => {
    renderOnramp()

    expect(screen.getByRole('heading', { name: /buy crypto with zar/i })).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it.each(['1', '5', '9.99'])('shows the minimum amount error for R%s', async (amount) => {
    const user = userEvent.setup()
    renderOnramp()

    await user.type(amountField(), amount)

    expect(await screen.findByText('Minimum amount is R10')).toBeInTheDocument()
  })

  it('does not show the minimum error for an empty amount', () => {
    renderOnramp()

    // `parseFloat('') || 0` is 0, and the hint is deliberately gated on > 0 so
    // an untouched field doesn't accuse the user of typing too little.
    expect(screen.queryByText('Minimum amount is R10')).not.toBeInTheDocument()
  })

  it('does not show the minimum error at exactly R10', async () => {
    const user = userEvent.setup()
    renderOnramp()

    await user.type(amountField(), '10')

    expect(screen.queryByText('Minimum amount is R10')).not.toBeInTheDocument()
  })

  it('keeps submit disabled while the amount is below the minimum', async () => {
    const user = userEvent.setup()
    renderOnramp()

    await user.type(amountField(), '5')
    fireEvent.change(bankSelect(), { target: { value: 'FNB' } })

    // A bank is chosen, so only the amount is holding submit back.
    expect(submitButton()).toBeDisabled()
  })

  it('requires a bank selection before enabling submit', async () => {
    const user = userEvent.setup()
    renderOnramp()

    await user.type(amountField(), '100')
    // Valid amount, no bank yet.
    expect(submitButton()).toBeDisabled()

    fireEvent.change(bankSelect(), { target: { value: 'FNB' } })
    await waitFor(() => expect(submitButton()).toBeEnabled())
  })

  it('offers every supported Ozow bank', () => {
    renderOnramp()

    const options = Array.from(bankSelect().querySelectorAll('option')).map((o) => o.value)
    expect(options).toEqual(OZOW_BANKS.map((bank) => bank.code))
  })
})

describe('ZarOnramp fee breakdown', () => {
  it('shows the amount, processing fee and total once an amount is entered', async () => {
    const user = userEvent.setup()
    renderOnramp()

    await user.type(amountField(), '100')

    expect(await screen.findByText(/R100\.00/)).toBeInTheDocument()
    // 1.5% of 100, with no VAT on Ozow.
    expect(screen.getByText('R1.50')).toBeInTheDocument()
    expect(screen.getByText('R101.50')).toBeInTheDocument()
  })

  it('shows no breakdown for an empty amount', () => {
    renderOnramp()

    expect(screen.queryByText('Total Cost')).not.toBeInTheDocument()
  })
})

describe('ZarOnramp submission', () => {
  it('calls api.createOzowPayment with the amount, bank and return URL', async () => {
    const user = userEvent.setup()
    renderOnramp()
    await fillValidForm(user, 'ABSA')

    await user.click(submitButton())

    await waitFor(() =>
      expect(mockCreateOzowPayment).toHaveBeenCalledWith(
        'test-token',
        100,
        'ABSA',
        `${ORIGIN}/charge?provider=ozow`
      )
    )
  })

  it('derives the return URL from the current origin', async () => {
    const user = userEvent.setup()
    renderOnramp()
    await fillValidForm(user)

    await user.click(submitButton())

    await waitFor(() =>
      expect(mockCreateOzowPayment).toHaveBeenCalledWith(
        'test-token',
        100,
        'FNB',
        expect.stringContaining(`${ORIGIN}/charge?provider=ozow`)
      )
    )
  })

  it('parses a decimal amount as a number, not a string', async () => {
    const user = userEvent.setup()
    renderOnramp()
    await fillValidForm(user)

    await user.clear(amountField())
    await user.type(amountField(), '250.75')

    await user.click(submitButton())

    await waitFor(() =>
      expect(mockCreateOzowPayment).toHaveBeenCalledWith(
        'test-token',
        250.75,
        'FNB',
        expect.any(String)
      )
    )
  })

  it('redirects to the payment_url returned by the API', async () => {
    const user = userEvent.setup()
    renderOnramp()
    await fillValidForm(user)

    await user.click(submitButton())

    // The whole point of the flow: the browser leaves for Ozow's hosted page.
    await waitFor(() => expect(mockRedirectTo).toHaveBeenCalledWith(PAYMENT_URL))
  })

  it('redirects to whatever URL the API returns, not a hard-coded one', async () => {
    const user = userEvent.setup()
    const custom = 'https://checkout.example/session/xyz?ref=42'
    mockCreateOzowPayment.mockResolvedValue({ payment_url: custom, transaction_id: 'txn-9' })
    renderOnramp()
    await fillValidForm(user)

    await user.click(submitButton())

    await waitFor(() => expect(mockRedirectTo).toHaveBeenCalledWith(custom))
  })

  it('does not call the API when the amount is below the minimum', async () => {
    const user = userEvent.setup()
    renderOnramp()
    await user.type(amountField(), '5')
    fireEvent.change(bankSelect(), { target: { value: 'FNB' } })

    await user.click(submitButton())

    expect(mockCreateOzowPayment).not.toHaveBeenCalled()
  })

  it('does not call the API when no bank is selected', async () => {
    const user = userEvent.setup()
    renderOnramp()
    await user.type(amountField(), '100')

    await user.click(submitButton())

    expect(mockCreateOzowPayment).not.toHaveBeenCalled()
  })
})

describe('ZarOnramp error handling', () => {
  it('shows the API error message in the alert', async () => {
    const user = userEvent.setup()
    mockCreateOzowPayment.mockRejectedValue(new ApiError('Ozow is unavailable', 502))
    renderOnramp()
    await fillValidForm(user)

    await user.click(submitButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Ozow is unavailable')
  })

  it('does not redirect when the API call fails', async () => {
    const user = userEvent.setup()
    mockCreateOzowPayment.mockRejectedValue(new ApiError('Ozow is unavailable', 502))
    renderOnramp()
    await fillValidForm(user)

    await user.click(submitButton())

    await screen.findByRole('alert')
    expect(mockRedirectTo).not.toHaveBeenCalled()
  })

  it('re-enables submit after a failure so the user can retry', async () => {
    const user = userEvent.setup()
    mockCreateOzowPayment.mockRejectedValue(new ApiError('Ozow is unavailable', 502))
    renderOnramp()
    await fillValidForm(user)

    await user.click(submitButton())
    await screen.findByRole('alert')

    // isProcessing must be cleared, or the form is stuck on "Processing…".
    expect(submitButton()).toBeEnabled()
  })

  it('falls back to a generic message for a non-Error rejection', async () => {
    const user = userEvent.setup()
    mockCreateOzowPayment.mockRejectedValue('a bare string')
    renderOnramp()
    await fillValidForm(user)

    await user.click(submitButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to initiate payment')
  })

  it('shows no alert before a submission is attempted', () => {
    renderOnramp()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
