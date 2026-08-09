'use client'

import { useRef, useState, type ReactNode } from 'react'

/**
 * Three-part address entry (street / postal code / city) with Enter
 * chaining field to field and submitting from the last one. Skippable:
 * the address is optional in onboarding, exactly like the wizard.
 */
interface AddressFieldsProps {
  placeholders: { street: string; postalCode: string; city: string }
  enterHint: ReactNode
  skipLabel: string
  onSubmit: (v: { addressLine1?: string; postalCode?: string; city?: string }) => void
}

export default function AddressFields({ placeholders, enterHint, skipLabel, onSubmit }: AddressFieldsProps) {
  const [street, setStreet] = useState('')
  const [zip, setZip] = useState('')
  const [city, setCity] = useState('')
  const zipRef = useRef<HTMLInputElement | null>(null)
  const cityRef = useRef<HTMLInputElement | null>(null)

  function submit() {
    onSubmit({
      addressLine1: street.trim() || undefined,
      postalCode: zip.trim() || undefined,
      city: city.trim() || undefined,
    })
  }

  return (
    <div>
      <div className="jny-addr">
        <div className="jny-biginput">
          <input
            value={street}
            placeholder={placeholders.street}
            aria-label={placeholders.street}
            autoComplete="off"
            autoFocus
            onChange={(e) => setStreet(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && zipRef.current?.focus()}
          />
        </div>
        <div className="jny-addr-row">
          <div className="jny-biginput jny-addr-zip">
            <input
              ref={zipRef}
              value={zip}
              placeholder={placeholders.postalCode}
              aria-label={placeholders.postalCode}
              inputMode="numeric"
              autoComplete="off"
              onChange={(e) => setZip(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && cityRef.current?.focus()}
            />
          </div>
          <div className="jny-biginput jny-addr-city">
            <input
              ref={cityRef}
              value={city}
              placeholder={placeholders.city}
              aria-label={placeholders.city}
              autoComplete="off"
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>
      </div>
      <p className="jny-enterhint">{enterHint}</p>
      <div className="jny-qactions">
        <button type="button" className="jny-btn-quiet" onClick={() => onSubmit({})}>
          {skipLabel}
        </button>
      </div>
    </div>
  )
}
