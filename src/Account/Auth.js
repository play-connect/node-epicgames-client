const Cheerio = require('cheerio');
const Readline = require('readline');
const ENDPOINT = require('../../resources/Endpoint');

const Prompt = Readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

class AccountAuth {

  constructor(client) {
    
    this.client = client;
    this.tokenTimeout = null;
    
  }

  async auth(twoFactorCode) {
    
    try {

      /**
       * Geting XSRF TOKEN
       */
      const token = await this.getXSRF();

      if (!token) throw new Error('[Account Authorization] Cannot get XSRF TOKEN!');


      /**
       * Sending login form
       */
      let { data } = await this.client.http.sendPost(`${ENDPOINT.LOGIN_FRONTEND}/login/doLauncherLogin`, 'launcher', {
        fromForm: 'yes',
        authType: null,
        linkExtAuth: null,
        client_id: this.client.auth.clientId,
        redirectUrl: `${ENDPOINT.LOGIN_FRONTEND}/login/showPleaseWait?client_id=${this.client.auth.clientId}&rememberEmail=false`,
        epic_username: this.client.config.email,
        password: this.client.config.password,
        rememberMe: 'NO',
      }, true, {
        'X-XSRF-TOKEN': token,
      });
      
      if (!data || !data.redirectURL) {
        
        const $ = Cheerio.load(data);
        const errorCodesElement = $('.errorCodes');

        if (errorCodesElement.length) {

          const errorMsg = errorCodesElement.text().trim();

          throw new Error(`[Account Authorization] Login form error: ${errorMsg}`);
        } else {

          const twoFactorFormElement = $('#twoFactorForm');
          if (twoFactorFormElement.length) {
            data = await this.submitTwoFactorCode(token, twoFactorFormElement, twoFactorCode);
          } else throw new Error('[Account Authorization] Cannot get "please wait" redirection URL!');

        }

      }

      /**
       * Reading exchange code from redirected "please wait" page
       */
      const exchangeCode = await this.getExchangeCode(data.redirectURL);

      if (!exchangeCode) throw new Error('[Account Authorization] Cannot get exchange code!');
      
      
      /**
       * Exchanging code on token "eg1"
       */
      const authData = await this.exchangeCode(exchangeCode);
      
      if (!authData) throw new Error('[Account Authorization] Cannot exchange code and receive authData!');

      
      /**
       * Ending auth process
       */

      this.setAuthParams(authData);
      this.setTokenTimeout();

      return true;

    } catch (err) {
      
      this.client.debug.print(err);

    }

    return false;
  }

  async submitTwoFactorCode(token, twoFactorFormElement, twoFactorCode) {

    const twoFactorForm = {
      challenge: twoFactorFormElement.find('input[name="challenge"]').val(),
      mfaMethod: twoFactorFormElement.find('input[name="mfaMethod"]').val(),
      alternateMfaMethods: twoFactorFormElement.find('input[name="alternateMfaMethods"]').val(),
      displayName: twoFactorFormElement.find('input[name="epic_username"]').val(),
      hideMessage: twoFactorFormElement.find('input[name="hideMessage"]').val(),
      linkExtAuth: twoFactorFormElement.find('input[name="linkExtAuth"]').val(),
      authType: twoFactorFormElement.find('input[name="authType"]').val(),
      clientId: twoFactorFormElement.find('input[name="client_id"]').val(),
      redirectUrl: twoFactorFormElement.find('input[name="redirectUrl"]').val(),
      rememberMe: twoFactorFormElement.find('input[name="rememberMe"]').val(),
    };

    if (!twoFactorCode) {

      twoFactorForm.twoFactorCode = await new Promise((resolve) => {
        Prompt.question(`Enter two factor code (${twoFactorForm.mfaMethod}): `, resolve);
      });

    } else {
      
      switch (typeof twoFactorCode) {

        case 'string':
          twoFactorForm.twoFactorCode = twoFactorCode;
          break;

        case 'number':
          twoFactorForm.twoFactorCode = twoFactorCode;
          break;
          
        case 'function':
          twoFactorForm.twoFactorCode = await twoFactorCode();
          break;

        default:
          throw new Error('`twoFactorCode` parameter must be `string`, `number` or `function`.');

      }

    }

    const { data } = await this.client.http.sendPost(
      `${ENDPOINT.LOGIN_FRONTEND}/login/doTwoFactor`
      + `?client_id=${this.client.auth.clientId}`,
      null,
      twoFactorForm,
      false,
      {
        'X-XSRF-TOKEN': this.client.http.jar.getCookies(`${ENDPOINT.LOGIN_FRONTEND}/login/doLauncherLogin`).find(cookie => cookie.key === 'XSRF-TOKEN').value,
      },
    );

    const $ = Cheerio.load(data);
    const errorCodesElement = $('.errorCodes');
    const fieldValidationErrorElement = $('label[for="twoFactorCode"].fieldValidationError');
    
    if (errorCodesElement.length) {

      // eslint-disable-next-line no-console
      console.log(`Error: ${errorCodesElement.text().trim()}`);
      return this.submitTwoFactorCode(token, $('#twoFactorForm'), twoFactorCode);

    }
    
    if (fieldValidationErrorElement.length) {

      // eslint-disable-next-line no-console
      console.log(`Error: ${fieldValidationErrorElement.text().trim()}`);
      return this.submitTwoFactorCode(token, $('#twoFactorForm'));
      
    }

    return JSON.parse(data);
  }

  async getXSRF() {
    await this.client.http.sendGet(
      `${ENDPOINT.LOGIN_FRONTEND}/login/doLauncherLogin`
      + `?client_id=${this.client.auth.clientId}`
      + `&redirectUrl=https%3A%2F%2Faccounts.launcher-website-prod07.ol.epicgames.com%2Flogin%2FshowPleaseWait%3Fclient_id%3D${this.client.auth.clientId}%26rememberEmail%3Dfalse`,
      'launcher',
    );
    return this.client.http.jar.getCookies(`${ENDPOINT.LOGIN_FRONTEND}/login/doLauncherLogin`).find(cookie => cookie.key === 'XSRF-TOKEN').value;
  }

  async getExchangeCode(url) {
    
    const { response: { body } } = await this.client.http.sendGet(url, 'launcher', {}, false);
    
    const regex = /com\.epicgames\.account\.web\.widgets\.loginWithExchangeCode\('(.*)'(.*?)\)/g;
    const matches = regex.exec(body);

    return matches[1] || false;
  }

  async exchangeCode(exchangeCode) {

    const { data } = await this.client.http.sendPost(ENDPOINT.OAUTH_TOKEN, 'launcher', {
      grant_type: 'exchange_code',
      exchange_code: exchangeCode,
      token_type: 'eg1',
      includePerms: false, // Account's permissions
    });
    
    return data || false;
  }

  async exchange() {
    
    try {
      
      const { data } = await this.client.http.sendGet(
        ENDPOINT.OAUTH_EXCHANGE,
        `${this.tokenType} ${this.accessToken}`,
      );
        
      if (data) {
        
        return data;
    
      }

    } catch (err) {
      
      this.client.debug.print(new Error(err));

    }
    
    return false;
  }

  async doRefreshToken() {

    this.client.debug.print('Refreshing account\'s token...');

    try {

      const { data } = await this.client.http.sendPost(ENDPOINT.OAUTH_TOKEN, 'launcher', {
        grant_type: 'refresh_token',
        refresh_token: this.refresh_token,
        includePerms: false, // Account's permissions
      });
      
      if (data) {

        this.setAuthParams(data);
        this.setTokenTimeout();

        this.client.emit('access_token_refreshed');

        this.client.debug.print('Account\'s token refreshed.');
        
        if (this.client.communicator) {
    
          await this.client.communicator.disconnect();
          await this.client.communicator.connect();
          
          this.client.debug.print('Communicator: Reconnected with new account\'s access token.');
    
        }

        return true;
    
      }

    } catch (err) {

      this.client.debug.print(new Error(err));

    }

    return false;
  }

  setAuthParams(data) {

    this.accessToken = data.access_token;
    this.expiresIn = data.expires_in;
    this.expiresAt = data.expires_at;
    this.tokenType = data.token_type;
    this.refreshToken = data.refresh_token;
    this.refreshExpires = data.refresh_expires;
    this.refreshExpiresAt = data.refresh_expires_at;
    this.accountId = data.account_id;
    this.clientId = data.client_id;
    this.internalClient = data.internal_client;
    this.clientService = data.client_service;
    this.lastPasswordValidation = data.lastPasswordValidation;
    this.app = data.app;
    this.inAppId = data.in_app_id;

  }

  setTokenTimeout() {
    
    if (this.tokenTimeout) clearTimeout(this.tokenTimeout);

    this.tokenTimeout = setTimeout(() => {
      this.doRefreshToken();
    }, (this.expiresIn - 180) * 1000);

  }

}

module.exports = AccountAuth;
