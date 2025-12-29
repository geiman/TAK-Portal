<h1 align='center'>TAK Portal</h1>

<p align="center">
TAK Portal is a lightweight, modern user-management portal designed to integrate seamlessly with <strong>Authentik</strong> and <strong>TAK Server</strong> for streamlined certificate and account control. Built specifically for agencies who need reliability, simplicity, and security.



## Features

- Authentik-driven identity and access management  
- Automatic certificate handling with TAK Server  
- Simple agency and user organization model  
- Clean, intuitive web UI  
- Packaged for Docker — fast to deploy and easy to maintain  

---

## Prerequisites

> [!NOTE]  
> TAK Portal relies on your *EXISTING* local:
>
> - Authentik Server — used for identity and user management  
> - TAK Server — used for certificate revocation  
>
> TAK Portal will run without TAK Server connected, but certificates will ***not*** be revoked when users are disabled or deleted.

*MORE INSTRUCTIONS NEED TO GO HERE FOR AUTHENTIK SETUP*

---

## Installation

On an Ubuntu machine, run:

```
git clone https://github.com/AdventureSeeker423/TAK-Portal
cd TAK-Portal
```

(Optional) Customize the UI Port

```
./takportal config
```

Start TAK Portal

```
./takportal start
```
---

## Configuration

1. Open your browser and navigate to the docker host IP and port. <br>
    &emsp; Default: `http://<server-ip>:3000` <br>
    &emsp; Example: `http://192.168.1.150:3000`
2. Open `Server Settings` (bottom of the sidebar).
3. Set the Authentik URL & Authentik API Token
4. Configure TAK Server (optional but recommended): <br>
    &emsp; - Set your TAK URL (ensure the correct port and keep /Marti at the end) <br>
    &emsp; - Upload webadmin.p12 and tak-ca.pem
    &emsp; - Provide the webadmin password (default is usually atakatak)
5. Scroll to the bottom and click *Save*.


## Getting Started

1. Navigate to `Manage Agencies` and create your first agency.
2. Navigate to `Agency Templates` and begin creating templates for your users (You may need to visit `Manage Groups` if there are no existing groups.)
3. Navigate to `Create Users` and create your first user