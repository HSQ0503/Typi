# How to Get an OpenAI API Key for Typi

Typi uses your OpenAI API key to generate typing plans. The key is stored locally in your Chrome profile and is used only when you ask Typi to plan a draft.

## Step-by-step setup

### 1. Create or sign in to your OpenAI Platform account

Open:

https://platform.openai.com/signup

Create an account or sign in with an existing OpenAI account.

### 2. Add billing if required

Open the billing page:

https://platform.openai.com/settings/organization/billing/overview

Add a payment method if your account does not already have API billing enabled.

> Note: ChatGPT Plus and OpenAI API billing are usually separate. Having ChatGPT Plus does not automatically mean API access is paid for.

### 3. Open the API keys page

Open:

https://platform.openai.com/api-keys

### 4. Create a new secret key

Click **Create new secret key**.

Recommended name:

```text
Typi
```

Copy the key immediately. OpenAI may only show it once.

### 5. Paste the key into Typi

1. Open a Google Doc.
2. Click the Typi Chrome extension.
3. Paste the key into the **OpenAI API key** field.
4. Click **Set API key for this user**.

After that, Typi should remember the key for this Chrome profile.

## Where the key is stored

Typi stores the key locally using Chrome extension storage. Typi does not operate its own backend server.

## What the key is used for

When you click **Plan & type**, Typi sends your draft text to OpenAI's API to generate a structured typing plan. The plan tells Typi what to write, where to pause, and where to add corrections/revisions.

## Troubleshooting

### “Set your OpenAI API key” error

Make sure you pasted the full key and clicked **Set API key for this user**.

### “Incorrect API key” or authentication error

Create a new key at:

https://platform.openai.com/api-keys

Then paste the new key into Typi.

### Billing or quota error

Check billing and usage here:

https://platform.openai.com/settings/organization/billing/overview

https://platform.openai.com/usage

### I lost the key

OpenAI usually does not let you view a secret key again. Create a new one here:

https://platform.openai.com/api-keys

Then replace the old key in Typi.
